import { runClaude, ReviewTimeoutError } from './review.mjs'

export function buildRefutationPrompt({ finding, pr }) {
  return [
    `You are auditing one claimed defect in pull request ${pr.repo}#${pr.number} at commit ${pr.headSha}.`,
    'The repository is checked out at this commit in your working directory. Read and grep the real code.',
    '',
    '## The claim to attack',
    `File: ${finding.file}:${finding.line}`,
    `Claim: ${finding.claim}`,
    `Stated consequence: ${finding.why}`,
    '',
    'Your job is to REFUTE this claim. Look for guards, callers, type constraints, or tests that make it a non-issue.',
    'A claim survives only if you can trace a concrete path to the stated failure.',
    'If you are uncertain, refute it — a wrong blocking review costs the author a full round trip.',
    '',
    'Respond with ONLY JSON: {"refuted": true|false, "why": "one sentence"}',
  ].join('\n')
}

// The same parse, plus the one bit parseRefutation deliberately collapses:
// whether the model honoured the contract at all. refuteBlockers needs it to
// tell "the model answered and the claim did not survive" from "we never got an
// answer"; every other caller only wants the safe reading.
function readVerdict(text) {
  try {
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    const parsed = JSON.parse(text.slice(first, last + 1))
    if (typeof parsed.refuted !== 'boolean') return { readable: false }
    return { readable: true, refuted: parsed.refuted, why: parsed.why || '' }
  } catch {
    return { readable: false }
  }
}

export function parseRefutation(text) {
  const verdict = readVerdict(text)
  return verdict.readable
    ? { refuted: verdict.refuted, why: verdict.why }
    : { refuted: true, why: 'refutation verdict unreadable' }
}

// This pass is the only unbounded fan-out in the pipeline: one child per
// blocking finding, run serially, each allowed five minutes, and each retried
// once. Measured before this existed — 2000 findings spawned 2000 children, and
// 100 findings with a retry apiece spawned 200 — a worst case per PR of
// 2 × 20min + 2 × N × 5min, over seventeen hours at N=100, all of it drawn from
// the operator's personal Claude subscription while their own work waits.
//
// Fifteen, because a review claiming more than about fifteen blocking defects
// is not an actionable review — nobody works through that list — so the cap is
// reached only when something has already gone wrong. It bounds a PR at
// 40 + 150 minutes rather than at nothing.
export const MAX_REFUTATIONS = 15

// The cap must never silently shrink a review. This sentence is published into
// the "Not verified" section of the review body, so it says plainly that
// nothing looked at these — never that they were cleared — and carries no path
// or internal state.
const cappedReason = (total) =>
  `not verified: this review raised ${total} blocking findings and only the first ${MAX_REFUTATIONS} are verified`

export async function refuteBlockers({ findings, pr, cwd, spawnImpl, timeoutMs }) {
  // Nits are never verified. They cannot change the verdict, so a refutation
  // call on one spends real quota and wall-clock for nothing — and the common
  // case, a PR with no blockers at all, must cost exactly zero child processes.
  const blockers = findings.filter((f) => f.severity === 'blocking')
  const survivors = []
  const refuted = []
  // Every attempt, including the ones that produced no verdict: a drop caused by
  // a wedged or failed refuter is only distinguishable from a real refutation by
  // its run (isError / timedOut), and a caller that shows an approval built on
  // unverified findings needs to be able to see that.
  const runs = []
  // Reads one attempt. Returns null when the model answered but broke the
  // contract — the only outcome worth asking again about.
  const decide = (run) => {
    // A run the CLI reports as failed is not a verdict in either direction. It
    // cannot clear the claim — and it cannot confirm one either: putting a
    // finding in front of the author on the strength of a failed run blocks them
    // over something nothing actually checked. A quota wall lands here, says
    // nothing whatever about the finding's merit, and is not beaten by asking
    // again a second later.
    if (run.isError) return { refuted: true, why: 'not verified: the refutation could not be completed', unverified: true }
    const verdict = readVerdict(run.result)
    return verdict.readable ? { refuted: verdict.refuted, why: verdict.why, unverified: false } : null
  }
  // Beyond the cap nothing is asked and nothing is asserted. They are recorded
  // exactly as a timed-out or errored refutation is — unverified — because that
  // is what they are, and it is what makes them show up in the review's "Not
  // verified" section and makes `degraded` true below. Two things follow, and
  // both are deliberate: an unchecked finding never BLOCKS the author, since
  // uncertainty must not cost a round trip on a claim that may well be wrong;
  // and an unchecked finding is never quietly approved over either, because
  // degraded-with-no-survivors refuses to post a verdict at all. The order is
  // the model's own, which puts what it considered most serious first.
  for (const finding of blockers.slice(MAX_REFUTATIONS)) {
    refuted.push({ ...finding, refutation: cappedReason(blockers.length), unverified: true })
  }
  for (const finding of blockers.slice(0, MAX_REFUTATIONS)) {
    const prompt = buildRefutationPrompt({ finding, pr })
    let verdict
    try {
      const run = await runClaude({ prompt, cwd, spawnImpl, timeoutMs })
      runs.push(run)
      verdict = decide(run)
      if (!verdict) {
        // One unparseable response is plausibly a formatting slip, so it earns a
        // second ask with the contract restated — the same courtesy runReview
        // extends to the review itself.
        const retry = await runClaude({ prompt: `${prompt}\n\nYour previous response was not valid JSON. Respond with ONLY the JSON object described above: {"refuted": true|false, "why": "one sentence"}`, cwd, spawnImpl, timeoutMs })
        runs.push(retry)
        // Twice through a strict, restated contract is not a considered judgment
        // about the finding; it is the contract not being honoured, which means
        // no answer was obtained. Reading it as a refutation on the merits is
        // precisely how a regressed or misconfigured model would quietly approve
        // a PR full of real blocking defects.
        verdict = decide(retry) ?? { refuted: true, why: 'not verified: the refutation did not answer in the required format', unverified: true }
      }
    } catch (e) {
      // A timeout is the same kind of event as an unreadable answer: nobody
      // produced a verdict, so the refute-by-default bias applies and the finding
      // is dropped. Letting it throw would strand an otherwise-complete review
      // over one slow claim, and blocking the author on a claim nothing verified
      // is the failure mode this whole pass exists to prevent.
      //
      // Only a timeout. A child that could not be spawned at all hands back no
      // run, so swallowing it would drop every blocker leaving no trace in
      // telemetry or anywhere else — an infrastructure failure that silently
      // turns REQUEST_CHANGES into APPROVE. That one has to reach a human.
      if (!(e instanceof ReviewTimeoutError)) throw Object.assign(e, { runs })
      if (e.run) runs.push(e.run)
      // Not "unreadable": the reason has to say the claim was never checked,
      // because a reader must not mistake this for a refutation on the merits.
      // The elapsed time and the budget stay in the run rather than being
      // interpolated here — this string may end up in a public comment, and
      // runClaude's message names the local worktree path.
      verdict = { refuted: true, why: 'not verified: the refutation timed out', unverified: true }
    }
    if (verdict.refuted) refuted.push({ ...finding, refutation: verdict.why, unverified: verdict.unverified })
    else survivors.push({ ...finding, confirmation: verdict.why })
  }
  // Refute-by-default is right when the model looked and could not substantiate
  // the claim: that is real uncertainty, and uncertainty must not block a PR. It
  // is NOT right when the refutation never happened — a timeout or a failed run
  // drops a finding for reasons that have nothing to do with its merit, and the
  // caller then sees zero survivors and posts an approval on a PR that may have
  // real defects. That is the worst thing this tool can do, and it is silent.
  //
  // So the pass reports whether any blocker was dropped unverified. Derived from
  // the per-finding record rather than tracked separately, so the flag and the
  // reasons rendered into the review body cannot drift apart. A model that
  // answered successfully but unreadably is deliberately NOT degraded.
  //
  // The rule this is built for (Task 13): degraded with no survivors must not
  // approve — restore the trigger label and retry next cycle, as for a usage
  // limit, because the correct verdict is genuinely unknown. Degraded WITH
  // survivors is safe to post: requesting changes on what was confirmed is still
  // actionable, which is why this is a flag and not a throw.
  const degraded = refuted.some((f) => f.unverified)
  return { survivors, refuted, runs, degraded }
}
