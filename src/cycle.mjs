import { selectPrs } from './discover.mjs'
import { TransientError, FatalError, isRetryableTransportCode } from './github.mjs'
import { ReviewTimeoutError, isUsageLimit } from './review.mjs'
import { emptyState, parseState, findSticky, renderStateComment, appendRound, alreadyReviewedSha, lastRound } from './state.mjs'
import { planReactionChange, resolveMention } from './reactions.mjs'
import {
  verdictToEvent, verdictName, renderReviewBody, renderAnnouncement,
  renderChangesRequested, renderNoNewCommits, criteriaVersionOf,
} from './render.mjs'

// Worst case is two calls per blocking finding, run serially, so the review's
// own 20-minute default would allow forty minutes of wall clock for a single
// claim. The refutation reads one finding against a checkout that is already on
// disk; if it has not answered in five minutes it is wedged, not thinking.
export const REFUTATION_TIMEOUT_MS = 5 * 60_000

// Named, not silent. listPrFiles reports truncation rather than throwing,
// because a legitimately enormous PR must not earn the never-retried label —
// but a review of an unknown fraction of a PR that does not say so is a review
// nobody can calibrate.
export const TRUNCATION_NOTE = '(further files beyond the pagination cap — not retrieved)'

const sizeOf = (f) => (f.additions || 0) + (f.deletions || 0)

export function buildDiff(files, maxDiffLines) {
  const skippedFiles = []
  const kept = []
  let lines = 0
  // Smallest-first so a single lockfile cannot crowd out real source files.
  for (const f of [...files].sort((a, b) => sizeOf(a) - sizeOf(b))) {
    if (!f.patch || lines + sizeOf(f) > maxDiffLines) {
      skippedFiles.push(f.filename)
      continue
    }
    lines += sizeOf(f)
    kept.push(`--- ${f.filename}\n${f.patch}`)
  }
  return { diff: kept.join('\n\n'), skippedFiles }
}

// The two outcomes are opposites and both are expensive to get wrong: transient
// re-queues the PR and retries it next cycle, everything else applies a sticky
// label no automation will ever clear. So membership is decided by type and by
// the structured run the review attaches — never by grepping an error message,
// which on a parse failure is the MODEL'S OWN PROSE about the diff and can say
// "rate limit" for reasons that have nothing to do with a quota.
export function isTransientFailure(error) {
  // A hang is deliberately not transient. This loop runs unattended against the
  // operator's personal subscription quota; a wedged review retried every cycle
  // would burn it with nobody ever seeing a signal, whereas the sticky label
  // stops after one occurrence and surfaces the problem to a human.
  if (error instanceof ReviewTimeoutError) return false
  if (error instanceof TransientError) return true
  if (error instanceof FatalError) return false
  if (isRetryableTransportCode(error?.cause?.code ?? error?.code)) return true
  // runReview attaches the failing run precisely so a quota wall can be told
  // apart from a model that simply would not emit JSON: both arrive as a
  // VerdictParseError, and only one of them is worth trying again.
  return Boolean(error?.run) && isUsageLimit(error.run)
}

// `runs` is the contract; `run` is a convenience alias for the last attempt.
// Tolerating its absence matters: a bare `for…of undefined` here would throw
// AFTER a review completed, converting a finished review into the sticky label.
const runsOf = (result) => result?.runs ?? (result?.run ? [result.run] : [])

function recordRuns({ telemetry, log, pr, round, phase, at, runs }) {
  try {
    for (const r of runs) {
      telemetry.record({
        at,
        // Without these three every row collapses into one bucket in
        // summarize(), reporting a whole measurement window as a single review.
        // `round` is the PR's review round, never the attempt index.
        repo: pr.repo,
        number: pr.number,
        round,
        phase,
        costUsd: r.costUsd,
        model: r.model,
        // input_tokens ONLY. Each call carries roughly 10-18k of cached prompt
        // overhead in cache_read/cache_creation; folding those in would report
        // that fixed overhead as work done on this PR.
        inputTokens: r.usage?.input_tokens,
        outputTokens: r.usage?.output_tokens,
        durationMs: r.durationMs,
      })
    }
  } catch (e) {
    // Measurement must never cost a review. record() writes to disk, and the
    // review phase is recorded BEFORE the verdict is posted, so an unwritable
    // telemetry path would otherwise strand a finished review on the sticky
    // never-retried label.
    log(`Telemetry write failed for ${pr.repo}#${pr.number}: ${e.message}. The review is unaffected.`)
  }
}

const bindingChanged = (a, b) =>
  (a?.ts ?? null) !== (b?.ts ?? null) || (a?.stateEmoji ?? null) !== (b?.stateEmoji ?? null)

// Slack is mirror, never gate: every call here is best-effort and returns the
// binding unchanged on failure. The GitHub review is the critical path, and a
// PR must not land on the never-retried label because a channel was archived.
function makeSlackOps({ slack, config, log }) {
  const attempt = async (what, ref, fn) => {
    try {
      return await fn()
    } catch (e) {
      log(`Slack ${what} failed for ${ref}: ${e.message}. Continuing — the GitHub review is the critical path.`)
      return null
    }
  }
  return {
    async announce(pr) {
      const posted = await attempt('announcement', `${pr.repo}#${pr.number}`, () =>
        slack.postMessage({ channel: config.slack.channel, text: renderAnnouncement({ pr, summary: 'Review starting…' }) })
      )
      return posted?.ts ? { channel: config.slack.channel, ts: posted.ts, stateEmoji: null } : null
    },
    // The announcement carries exactly one state emoji, so the previous one has
    // to come off as the new one goes on or a PR that went ❌ then ✅ wears both.
    async reconcile(binding, verdict, ref) {
      if (!binding?.ts) return binding
      const plan = planReactionChange({ previous: binding.stateEmoji, verdict, emoji: config.slack.emoji })
      const ok = await attempt('reaction update', ref, async () => {
        if (plan.remove) await slack.removeReaction({ channel: binding.channel, ts: binding.ts, name: plan.remove })
        if (plan.add) await slack.addReaction({ channel: binding.channel, ts: binding.ts, name: plan.add })
        return true
      })
      // Only claim the new emoji if it actually went on, or the next round would
      // try to remove a reaction that was never added.
      return ok ? { ...binding, stateEmoji: plan.next } : binding
    },
    async reply(binding, text, ref) {
      if (!binding?.ts) return
      await attempt('thread reply', ref, () => slack.postThreadReply({ channel: binding.channel, threadTs: binding.ts, text }))
    },
    // authorMap only. resolveMention still supports an email-lookup tier, but
    // this caller never had an address to give it — GitHub does not reliably
    // expose an author's email on a PR payload — so the tier was unreachable
    // from here while implying a capability the tool does not have.
    async mention(login) {
      const resolved = await resolveMention({ login, authorMap: config.authorMap })
      // An unpingable author is otherwise invisible: the reply still posts, it
      // just never reaches the one person who has to act on it. With the email
      // tier gone this warning is the ONLY thing that surfaces a missing entry.
      if (!resolved.mapped) {
        log(`No Slack member ID for "${login}" — add them to authorMap in team.json so they get pinged.`)
      }
      return resolved
    },
  }
}

// async so that a synchronous throw surfaces as a rejected promise: the failure
// path attaches a .catch to this, and a sync throw would sail straight past it
// and out of runCycle, skipping the label handling that decides the PR's fate.
const writeState = async ({ github, pr, sticky, state }) => {
  const body = renderStateComment(state)
  return sticky ? github.updateIssueComment(pr.repo, sticky.id, body) : github.createIssueComment(pr.repo, pr.number, body)
}

// Prefixed to a preserved review so nobody reads a body headed "✅ Approved" as
// an approval that actually landed. Fixed prose, deliberately: this string is
// published, and render.mjs's rule is that no raw internal error text, path or
// environment value may reach a public comment. The cause goes to the log.
export const REVIEW_FALLBACK_NOTE =
  '> ⚠️ **GitHub rejected this review, so it is reproduced here as a plain comment.** ' +
  'No formal review state was recorded on this PR and the bot has stopped working on it — a human needs to look.'

// By the time this POST happens the review is the most expensive artifact the
// pipeline produces: a full model review plus up to two refutation calls per
// blocking finding, minutes of wall clock, all drawn from the operator's own
// subscription quota. Losing it to a rejected POST means paying for it again
// next round while the author sees nothing at all, so the body is preserved as
// an ordinary comment — strictly better than silence, since the findings stay
// readable and actionable even though the review state never landed.
//
// The likeliest trigger is the very thing that forced the GitHub App design:
// GitHub answers 422 "Can not approve your own pull request" to a personal
// token, so a misconfigured installation hits this on its first approval.
async function postReviewOrPreserve({ github, pr, event, body, ref }) {
  try {
    return await github.createReview(pr.repo, pr.number, { event, body })
  } catch (error) {
    // A transient rejection (502, secondary rate limit) is retried next cycle
    // and would then post the findings a second time, so only a deterministic
    // rejection earns the fallback. 422 is deterministic: never retried, since
    // retrying costs time and cannot succeed.
    if (isTransientFailure(error)) throw error
    let preserved
    try {
      await github.createIssueComment(pr.repo, pr.number, `${REVIEW_FALLBACK_NOTE}\n\n${body}`)
      preserved = 'the review body was preserved as a plain comment'
    } catch (fallbackError) {
      // Letting this one propagate on its own would report only that the
      // comment failed and lose the rejection that caused it — the single most
      // useful fact for whoever has to clear the sticky label.
      preserved = `preserving it as a plain comment ALSO failed: ${fallbackError.message}`
    }
    throw new FatalError(`GitHub rejected the review on ${ref}: ${error.message} — ${preserved}`, { cause: error })
  }
}

// A dry run is the LIVE path with its mutating calls removed, never a separate
// branch: a preview that renders through different code is a preview that can
// disagree with what would actually be posted, and the whole point is to trust
// it enough to tune review-criteria.md against it. Replacing the methods rather
// than guarding each call site also means no mutation can survive a forgotten
// `if (!dryRun)` — the functions that would mutate are simply not present.
//
// createReview is where the preview is emitted, because that is the exact call
// that would publish: whatever reaches this stub is byte-for-byte what GitHub
// would have received.
function previewGitHub(github, log) {
  return {
    ...github,
    createReview: async (repo, number, { event, body }) => {
      log(`\n[dry-run] ${repo}#${number} — would post ${event}:\n\n${body}\n`)
      return { html_url: null }
    },
    createIssueComment: async () => ({ id: 0 }),
    updateIssueComment: async (repo, id) => ({ id }),
    addLabel: async () => {},
    removeLabel: async () => {},
  }
}

// Every method a no-op, and postMessage deliberately returns no `ts`: that is
// what makes announce() yield a null binding, so nothing downstream threads,
// reacts, or writes a Slack binding into the ledger.
function previewSlack() {
  return {
    postMessage: async () => ({}),
    postThreadReply: async () => ({}),
    addReaction: async () => ({}),
    removeReaction: async () => ({}),
  }
}

export async function runCycle({ config, deps, dryRun = false, now = new Date().toISOString() }) {
  const { checkouts, runReview, refuteBlockers, telemetry, botLogin, log } = deps
  const github = dryRun ? previewGitHub(deps.github, log) : deps.github
  const slack = dryRun ? previewSlack() : deps.slack
  const slackOps = makeSlackOps({ slack, config, log })
  const criteriaVersion = criteriaVersionOf(config.criteria)
  const processed = []

  const candidates = []
  for (const repo of config.repos) {
    candidates.push(...selectPrs(await github.listOpenPrs(repo), config))
  }
  // selectPrs already caps and orders WITHIN a repo, so this second pass only
  // matters across them — and it is the difference between a per-cycle budget
  // and a per-repo one. Without the re-sort the first repo is served to
  // exhaustion before the second is looked at, so a repo that always has
  // maxPerCycle labelled PRs starves every repo listed after it, permanently.
  candidates.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))

  const selected = candidates.slice(0, config.maxPerCycle)

  // Said BEFORE the first model call, never after: a warning that arrives once
  // the money is spent is not a warning. A dry run makes the identical calls a
  // live review does, against the operator's own Claude subscription.
  if (dryRun && selected.length) {
    log(`[dry-run] ${selected.length} PR(s) would be reviewed:`)
    for (const pr of selected) log(`  ${pr.repo}#${pr.number} (${pr.headSha.slice(0, 7)}) "${pr.title}"`)
    log(
      `[dry-run] Reviewing them now for real: same prompts, same criteria, same model calls, ` +
        `so this spends the same Claude subscription quota a live review does. ` +
        `Nothing is posted, labelled, or mirrored to Slack — each review is printed below instead.`
    )
  }

  for (const pr of selected) {
    const ref = `${pr.repo}#${pr.number}`

    let claimed = false
    let worktree = null
    let sticky = null
    let state = emptyState()
    let binding = null
    // Which model call is in flight, so a failure can still report its cost
    // under the right phase.
    let phase = null
    try {
      const [reviews, comments] = await Promise.all([
        github.listReviews(pr.repo, pr.number),
        github.listIssueComments(pr.repo, pr.number),
      ])
      sticky = findSticky(comments, botLogin)
      // parseState answers null for anything it cannot read unambiguously; the
      // heal is to rebuild from empty, which costs a re-announce and is undone
      // by the head-SHA check below.
      state = (sticky && parseState(sticky.body)) || emptyState()
      binding = state.slack ?? null
      const round = state.rounds.length + 1

      if (alreadyReviewedSha(reviews, botLogin, pr.headSha)) {
        // The one place a dry run deliberately diverges from the live path.
        // Re-running against a PR that was already reviewed IS the criteria
        // tuning loop — edit the criteria, re-run, read the output — and the
        // skip exists only to avoid posting a duplicate review, which a dry
        // run cannot do. Honouring it here would leave the operator able to
        // preview only PRs the bot has never seen, which is the opposite of
        // the ones they want to check.
        if (!dryRun) {
          await slackOps.reply(binding, renderNoNewCommits({ round: state.rounds.length }), ref)
          await github.removeLabel(pr.repo, pr.number, config.labels.requested)
          processed.push({ repo: pr.repo, number: pr.number, outcome: 'skipped_same_sha' })
          continue
        }
        log(`[dry-run] ${ref} was already reviewed at ${pr.headSha.slice(0, 7)}, so a live cycle would skip it. Previewing anyway.`)
      }

      // Claimed before ANY expensive work — before the diff, the checkout, the
      // announcement and the model. An overlapping cycle that reads the labels
      // between these two calls has to see the PR already taken, or the same
      // head gets reviewed twice and the author gets two reviews.
      await github.removeLabel(pr.repo, pr.number, config.labels.requested)
      await github.addLabel(pr.repo, pr.number, config.labels.inProgress)
      claimed = true

      const prFiles = await github.listPrFiles(pr.repo, pr.number)
      const { diff, skippedFiles } = buildDiff(prFiles.files, config.maxDiffLines)
      if (prFiles.truncated) skippedFiles.push(TRUNCATION_NOTE)

      if (!binding?.ts) binding = await slackOps.announce(pr)
      binding = await slackOps.reconcile(binding, 'in_review', ref)

      worktree = await checkouts.worktreeForPr({ repo: pr.repo, number: pr.number, sha: pr.headSha })

      phase = 'review'
      const reviewResult = await runReview({
        criteria: config.criteria, pr, diff, skippedFiles, cwd: worktree.dir,
        previousBlockers: lastRound(state)?.blockers ?? [],
      })
      // Every attempt, not just the last: a retried review is the expensive
      // kind, so dropping the first understates exactly the reviews that cost
      // the most — corrupting the measurement telemetry exists for.
      recordRuns({ telemetry, log, pr, round, phase, at: now, runs: runsOf(reviewResult) })
      const { verdict } = reviewResult

      phase = 'verify'
      const refutation = await refuteBlockers({
        findings: verdict.findings, pr, cwd: worktree.dir, timeoutMs: REFUTATION_TIMEOUT_MS,
      })
      recordRuns({ telemetry, log, pr, round, phase, at: now, runs: runsOf(refutation) })
      phase = null

      const { survivors } = refutation
      const refuted = refutation.refuted ?? []
      const unverified = refuted.filter((f) => f.unverified)
      // Derived when the flag is absent rather than assumed false: the fallback
      // can only ever refuse to approve, which is the safe direction, and it is
      // the same expression refuteBlockers itself uses.
      const degraded = refutation.degraded ?? unverified.length > 0

      // The single most dangerous state this pipeline can reach. Zero survivors
      // reads identically whether every blocker was genuinely refuted or
      // nothing was ever checked, and one of those is a green check on code
      // nobody looked at. Degraded WITH survivors is safe to post — requesting
      // changes on what was confirmed is still actionable — but degraded with
      // none means the correct verdict is unknown, so nothing is posted and the
      // PR is re-queued exactly as for a usage limit.
      if (degraded && survivors.length === 0) {
        throw new TransientError(
          `refutation could not verify ${unverified.length} blocking finding(s) on ${ref} and none survived, so the correct verdict is unknown; nothing posted, re-queued for the next cycle`
        )
      }

      const body = renderReviewBody({
        round,
        summary: verdict.summary,
        blockers: survivors,
        nits: verdict.findings.filter((f) => f.severity === 'nit'),
        resolved: verdict.previousBlockersResolved,
        // Without this the "not verified" caveat vanishes and a review that
        // could not check a claim reads exactly like one that did.
        unverified,
        skippedFiles,
        criteriaVersion,
      })
      const posted = await postReviewOrPreserve({ github, pr, event: verdictToEvent(survivors), body, ref })
      const name = verdictName(survivors)

      binding = await slackOps.reconcile(binding, name, ref)
      if (name === 'changes_requested' && binding?.ts) {
        const mention = await slackOps.mention(pr.author)
        await slackOps.reply(binding, renderChangesRequested({
          mentionText: mention.text, round, blockers: survivors,
          pr: { ...pr, url: posted?.html_url || pr.url },
        }), ref)
      }

      await writeState({ github, pr, sticky, state: appendRound({ ...state, slack: binding, criteriaVersion }, {
        sha: pr.headSha, verdict: name, at: now,
        blockers: survivors.map((b) => ({ file: b.file, line: b.line, claim: b.claim })),
      }) })

      await github.removeLabel(pr.repo, pr.number, config.labels.inProgress)
      processed.push({ repo: pr.repo, number: pr.number, outcome: dryRun ? 'dry_run' : 'reviewed', verdict: name })
    } catch (error) {
      const transient = isTransientFailure(error)
      // Whatever went wrong, the run is over: nothing else in the cycle may
      // read this PR as still being worked on.
      if (claimed) await github.removeLabel(pr.repo, pr.number, config.labels.inProgress).catch(() => {})
      // The label IS the decision, and it is the only part of this block the
      // next cycle reads: `review-requested` means try again, `review-error`
      // means a human must look. It goes on before any of the cosmetic repair
      // below, so that nothing in between can leave the PR wearing no label at
      // all — a state no later cycle would ever pick up again.
      await github
        .addLabel(pr.repo, pr.number, transient ? config.labels.requested : config.labels.error)
        .catch(() => {})
      if (phase) recordRuns({ telemetry, log, pr, round: state.rounds.length + 1, phase, at: now, runs: runsOf(error) })
      if (!transient) {
        // ⚠️ replaces 👀. A per-PR failure is a third terminal state, and since
        // review-error is never auto-retried, nothing would ever come back to
        // move a reaction left saying "reviewing right now".
        binding = await slackOps.reconcile(binding, 'error', ref)
      }
      // A ts minted this cycle is only durable once it reaches the sticky
      // comment. Without this, any failure after the announcement re-announces
      // next cycle, orphaning the reaction on the first message.
      //
      // Only the binding — deliberately NOT a round. state.mjs has a
      // VERDICT_LABEL.error entry that invites appending an "errored" round
      // here, and doing so is a trap: previousBlockers is read from
      // lastRound(state).blockers, so an error round (blockers: []) would make
      // the NEXT review forget every outstanding blocker from the last real
      // round, and silently re-approve what it already asked to be fixed.
      if (bindingChanged(binding, state.slack)) {
        await writeState({ github, pr, sticky, state: { ...state, slack: binding } })
          .catch((e) => log(`Could not persist the Slack binding for ${ref}: ${e.message}`))
      }
      processed.push({ repo: pr.repo, number: pr.number, outcome: 'error' })
      log(`${ref} ${transient ? 'deferred' : 'failed'}: ${error.message}`)
      // Not this PR's fault: it is back in the queue, so stop rather than
      // marching the rest of the cycle into the same wall.
      if (transient) return { processed, aborted: true, reason: error.message }
    } finally {
      if (worktree) await worktree.cleanup().catch(() => {})
    }
  }

  return { processed, aborted: false }
}
