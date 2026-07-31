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

export function parseRefutation(text) {
  try {
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    const parsed = JSON.parse(text.slice(first, last + 1))
    if (typeof parsed.refuted !== 'boolean') return { refuted: true, why: 'refutation verdict unreadable' }
    return { refuted: parsed.refuted, why: parsed.why || '' }
  } catch {
    return { refuted: true, why: 'refutation verdict unreadable' }
  }
}

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
  for (const finding of blockers) {
    let verdict
    try {
      const run = await runClaude({ prompt: buildRefutationPrompt({ finding, pr }), cwd, spawnImpl, timeoutMs })
      runs.push(run)
      verdict = parseRefutation(run.result)
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
      verdict = { refuted: true, why: 'not verified: the refutation timed out' }
    }
    if (verdict.refuted) refuted.push({ ...finding, refutation: verdict.why })
    else survivors.push({ ...finding, confirmation: verdict.why })
  }
  return { survivors, refuted, runs }
}
