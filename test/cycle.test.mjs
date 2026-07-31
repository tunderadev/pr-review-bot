import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runCycle, REVIEW_FALLBACK_NOTE } from '../src/cycle.mjs'
import { renderStateComment, emptyState, appendRound, parseState } from '../src/state.mjs'
import { TransientError, FatalError } from '../src/github.mjs'
import { ReviewTimeoutError } from '../src/review.mjs'

const BOT = 'plat-reviewer[bot]'
const NOW = '2026-07-29T18:00:00Z'

const config = {
  team: 'platform',
  repos: ['o/r'],
  titlePrefix: '^\\[PLAT\\]',
  labels: { requested: 'review-requested', inProgress: 'review-in-progress', error: 'review-error' },
  slack: { channel: 'C1', emoji: { inReview: 'eyes', approved: 'white_check_mark', changesRequested: 'x', error: 'warning' } },
  authorMap: { octocat: 'U1' },
  maxPerCycle: 3,
  maxDiffLines: 3000,
  criteria: 'be careful',
  telemetry: false,
}

const rawPr = (over = {}) => ({
  number: 7, title: '[PLAT] add widget', state: 'open', draft: false,
  updated_at: NOW, html_url: 'https://gh/pr/7', user: { login: 'octocat' },
  head: { sha: 'abc1234' }, base: { repo: { full_name: 'o/r' } },
  labels: [{ name: 'review-requested' }], ...over,
})

const RUN = { costUsd: 0.25, usage: { input_tokens: 100, output_tokens: 20 }, durationMs: 11, model: 'm' }
const okVerdict = (over = {}) => ({ summary: 'Adds a widget.', findings: [], previousBlockersResolved: [], ...over })
const blocking = (over = {}) => ({ severity: 'blocking', file: 'src/a.ts', line: 42, claim: 'unhandled null', why: 'crash', ...over })

const priorState = appendRound(
  { ...emptyState(), slack: { channel: 'C1', ts: '111.222', stateEmoji: 'x' } },
  { sha: 'old999', verdict: 'changes_requested', at: NOW, blockers: [{ file: 'src/a.ts', line: 42, claim: 'unhandled null' }] }
)
const stickyComment = (state) => ({ id: 11, user: { login: BOT }, body: renderStateComment(state) })

// Every action the cycle can take against the outside world lands in one
// ordered list, so a test can assert not just THAT something happened but
// when — the claim has to precede the expensive work, and a dry run has to
// produce an empty list rather than merely a label-free one.
function makeDeps(over = {}) {
  const actions = []
  const logs = []
  const calls = { review: [], refute: [], worktree: [], telemetry: [] }

  const github = {
    listOpenPrs: async () => [rawPr()],
    listReviews: async () => [],
    listIssueComments: async () => [],
    listPrFiles: async () => ({ files: [{ filename: 'src/a.ts', additions: 5, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' }], truncated: false }),
    createIssueComment: async (r, n, body) => { actions.push(['comment', body]); return { id: 11 } },
    updateIssueComment: async (r, id, body) => { actions.push(['update-comment', id, body]); return { id } },
    addLabel: async (r, n, name) => { actions.push(['add-label', name]) },
    removeLabel: async (r, n, name) => { actions.push(['remove-label', name]) },
    createReview: async (r, n, x) => { actions.push(['review', x.event, x.body]); return { html_url: 'https://gh/review/1' } },
    ...over.github,
  }
  const slack = {
    postMessage: async ({ text }) => { actions.push(['slack-post', text]); return { ts: '111.222' } },
    postThreadReply: async ({ text }) => { actions.push(['slack-thread', text]) },
    addReaction: async ({ name }) => { actions.push(['react-add', name]) },
    removeReaction: async ({ name }) => { actions.push(['react-remove', name]) },
    lookupUserByEmail: async () => null,
    ...over.slack,
  }
  const runReview = over.runReview ?? (async () => ({ verdict: okVerdict(), runs: [RUN], run: RUN }))
  const refuteBlockers = over.refuteBlockers ?? (async ({ findings }) => ({
    survivors: findings.filter((f) => f.severity === 'blocking'), refuted: [], runs: [], degraded: false,
  }))
  const worktreeForPr = over.worktreeForPr ?? (async () => ({ dir: '/wt', cleanup: async () => { actions.push(['cleanup']) } }))
  const telemetry = over.telemetry ?? { enabled: true, record: (e) => { calls.telemetry.push(e); return true } }

  // Markers are pushed BEFORE delegating, so a stub that throws still proves it
  // was reached — "zero review calls" must not be satisfiable by a throw.
  const deps = {
    github: { ...github, listPrFiles: async (...a) => { actions.push(['files']); return github.listPrFiles(...a) } },
    slack,
    checkouts: { worktreeForPr: async (a) => { actions.push(['worktree']); calls.worktree.push(a); return worktreeForPr(a) } },
    runReview: async (a) => { actions.push(['review-call']); calls.review.push(a); return runReview(a) },
    refuteBlockers: async (a) => { actions.push(['refute-call']); calls.refute.push(a); return refuteBlockers(a) },
    telemetry,
    botLogin: BOT,
    log: (m) => { logs.push(m) },
  }
  return { deps, actions, calls, logs }
}

const named = (actions, name, value) => actions.filter((a) => a[0] === name && (value === undefined || a[1] === value))
const bodyOf = (actions) => named(actions, 'review')[0]?.[2]

test('round 1 approve: claims label, announces, reviews, reacts, clears label', async () => {
  const { deps, actions } = makeDeps()
  const out = await runCycle({ config, deps, now: NOW })

  assert.deepEqual(out.processed, [{ repo: 'o/r', number: 7, outcome: 'reviewed', verdict: 'approved' }])
  assert.equal(out.aborted, false)
  assert.ok(named(actions, 'remove-label', 'review-requested').length === 1)
  assert.ok(named(actions, 'add-label', 'review-in-progress').length === 1)
  assert.ok(named(actions, 'slack-post').length === 1)
  assert.ok(named(actions, 'review', 'APPROVE').length === 1)
  assert.ok(named(actions, 'react-add', 'white_check_mark').length === 1)
  assert.ok(named(actions, 'remove-label', 'review-in-progress').length === 1)
  assert.ok(named(actions, 'comment').length === 1, 'the ledger is created on round 1')
  assert.ok(named(actions, 'cleanup').length === 1)
  assert.equal(named(actions, 'slack-thread').length, 0, 'approval posts no thread reply')
})

test('the label claim lands before any expensive work', async () => {
  const { deps, actions } = makeDeps()
  await runCycle({ config, deps, now: NOW })

  const at = (name, value) => actions.findIndex((a) => a[0] === name && (value === undefined || a[1] === value))
  const release = at('remove-label', 'review-requested')
  const claim = at('add-label', 'review-in-progress')
  const spend = actions.findIndex((a) => ['files', 'worktree', 'review-call', 'refute-call', 'slack-post'].includes(a[0]))
  assert.ok(release !== -1 && claim !== -1 && spend !== -1)
  // An overlapping cycle that reads the label between these two points must see
  // the PR already taken, or the same head gets reviewed twice.
  assert.ok(release < spend, `trigger label released at ${release}, first spend at ${spend}`)
  assert.ok(claim < spend, `in-progress claimed at ${claim}, first spend at ${spend}`)
})

test('changes requested reacts x and threads a tagged reply', async () => {
  const { deps, actions } = makeDeps({
    runReview: async () => ({ verdict: okVerdict({ findings: [blocking()] }), runs: [RUN] }),
  })
  const out = await runCycle({ config, deps, now: NOW })
  assert.equal(out.processed[0].verdict, 'changes_requested')
  assert.ok(named(actions, 'review', 'REQUEST_CHANGES').length === 1)
  assert.ok(named(actions, 'react-add', 'x').length === 1)
  const thread = actions.find((a) => a[0] === 'slack-thread')
  assert.match(thread[1], /<@U1>/)
  assert.match(thread[1], /unhandled null/)
  assert.match(thread[1], /https:\/\/gh\/review\/1/, 'the reply links the review that was just posted')
})

test('the GitHub review is posted before the Slack reconcile', async () => {
  const { deps, actions } = makeDeps({
    runReview: async () => ({ verdict: okVerdict({ findings: [blocking()] }), runs: [RUN] }),
  })
  await runCycle({ config, deps, now: NOW })
  const review = actions.findIndex((a) => a[0] === 'review')
  const thread = actions.findIndex((a) => a[0] === 'slack-thread')
  assert.ok(review !== -1 && thread !== -1)
  assert.ok(review < thread, 'Slack mirrors the verdict; it never gates it')
})

test('refuted blockers flip the verdict to approve', async () => {
  const { deps, actions } = makeDeps({
    runReview: async () => ({ verdict: okVerdict({ findings: [blocking({ claim: 'bogus' })] }), runs: [RUN] }),
    refuteBlockers: async ({ findings }) => ({
      survivors: [], refuted: [{ ...findings[0], refutation: 'guarded upstream', unverified: false }], runs: [], degraded: false,
    }),
  })
  const out = await runCycle({ config, deps, now: NOW })
  assert.equal(out.processed[0].verdict, 'approved')
  assert.ok(named(actions, 'review', 'APPROVE').length === 1)
  assert.doesNotMatch(bodyOf(actions), /Not verified/, 'a refutation on the merits is not a caveat')
})

test('a degraded pass with survivors still requests changes, naming what went unverified', async () => {
  const { deps, actions } = makeDeps({
    runReview: async () => ({
      verdict: okVerdict({ findings: [blocking({ claim: 'real defect' }), blocking({ claim: 'never checked' })] }),
      runs: [RUN],
    }),
    refuteBlockers: async ({ findings }) => ({
      survivors: [findings[0]],
      refuted: [{ ...findings[1], refutation: 'not verified: the refutation timed out', unverified: true }],
      runs: [], degraded: true,
    }),
  })
  const out = await runCycle({ config, deps, now: NOW })
  assert.equal(out.processed[0].verdict, 'changes_requested')
  const body = bodyOf(actions)
  // Dropping `unverified` from the renderReviewBody call removes this section
  // silently: the review still reads as a complete one.
  assert.match(body, /### Not verified \(1\)/)
  assert.match(body, /never checked/)
  assert.match(body, /the refutation timed out/)
  assert.doesNotMatch(body.split('### Not verified')[1], /real defect/, 'a survivor is not listed as unverified')
})

test('degraded with no survivors never approves — it re-queues instead', async () => {
  const { deps, actions } = makeDeps({
    runReview: async () => ({ verdict: okVerdict({ findings: [blocking()] }), runs: [RUN] }),
    refuteBlockers: async ({ findings }) => ({
      survivors: [],
      refuted: [{ ...findings[0], refutation: 'not verified: the refutation could not be completed', unverified: true }],
      runs: [], degraded: true,
    }),
  })
  const out = await runCycle({ config, deps, now: NOW })
  // Zero survivors reads identically to a clean review, so the only thing
  // standing between a wedged refuter and a green check is this branch.
  assert.equal(named(actions, 'review').length, 0, 'nothing may be posted when the correct verdict is unknown')
  assert.ok(named(actions, 'add-label', 'review-requested').length === 1, 're-queued for the next cycle')
  assert.equal(named(actions, 'add-label', 'review-error').length, 0, 'not this PR\'s fault — no sticky label')
  assert.ok(named(actions, 'remove-label', 'review-in-progress').length === 1)
  assert.equal(out.aborted, true)
  assert.equal(out.processed[0].outcome, 'error')
})

test('same head SHA: no review, no tokens, label cleared, thread explains', async () => {
  const { deps, actions, calls } = makeDeps({
    github: {
      listReviews: async () => [{ user: { login: BOT }, commit_id: 'abc1234', state: 'APPROVED' }],
      listIssueComments: async () => [stickyComment(appendRound(
        { ...emptyState(), slack: { channel: 'C1', ts: '111.222', stateEmoji: 'white_check_mark' } },
        { sha: 'abc1234', verdict: 'approved', at: NOW, blockers: [] }
      ))],
    },
    runReview: async () => { throw new Error('must not review') },
  })
  const out = await runCycle({ config, deps, now: NOW })
  assert.equal(out.processed[0].outcome, 'skipped_same_sha')
  // Not the outcome string alone: the marker is pushed before the stub runs, so
  // a review that was started and then discarded would still show up here.
  assert.equal(calls.review.length, 0)
  assert.equal(named(actions, 'review-call').length, 0)
  assert.equal(named(actions, 'worktree').length, 0, 'no checkout for a PR that will not be reviewed')
  assert.equal(named(actions, 'files').length, 0)
  assert.equal(calls.telemetry.length, 0)
  assert.ok(actions.some((a) => a[0] === 'slack-thread' && /no new commits/i.test(a[1])))
  assert.ok(named(actions, 'remove-label', 'review-requested').length === 1)
  assert.equal(named(actions, 'review').length, 0)
  assert.equal(named(actions, 'add-label').length, 0, 'nothing is claimed and nothing is flagged')
})

test('round 2 reuses the existing Slack ts and reconciles the stale reaction', async () => {
  const { deps, actions, calls } = makeDeps({
    github: { listIssueComments: async () => [stickyComment(priorState)] },
    runReview: async () => ({
      verdict: okVerdict({ previousBlockersResolved: [{ claim: 'unhandled null', resolved: true, how: 'guard added' }] }),
      runs: [RUN],
    }),
  })
  await runCycle({ config, deps, now: NOW })
  assert.equal(calls.review[0].previousBlockers.length, 1, 'round 2 must receive round 1 blockers')
  assert.equal(named(actions, 'slack-post').length, 0, 'must not re-announce')
  assert.ok(named(actions, 'react-remove', 'x').length === 1)
  assert.ok(named(actions, 'react-add', 'white_check_mark').length === 1)
  assert.equal(named(actions, 'comment').length, 0, 'the existing ledger is edited, never duplicated')
  const ledger = named(actions, 'update-comment')[0]
  assert.ok(ledger)
  const written = parseState(ledger[2])
  assert.equal(written.rounds.length, 2)
  assert.equal(written.slack.ts, '111.222')
  assert.equal(written.slack.stateEmoji, 'white_check_mark')
  assert.match(bodyOf(actions), /Round 2/)
})

test('transient failure restores review-requested, aborts cycle, sets no error label', async () => {
  const { deps, actions } = makeDeps({
    github: { listOpenPrs: async () => [rawPr({ number: 7 }), rawPr({ number: 8, updated_at: '2026-07-29T19:00:00Z' })] },
    runReview: async () => { throw new TransientError('429 slow down') },
  })
  const out = await runCycle({ config, deps, now: NOW })
  assert.equal(out.aborted, true)
  assert.match(out.reason, /429/)
  assert.deepEqual(out.processed, [{ repo: 'o/r', number: 7, outcome: 'error' }], 'the rest of the cycle is abandoned')
  assert.ok(named(actions, 'add-label', 'review-requested').length === 1, 'label restored for retry')
  assert.equal(named(actions, 'add-label', 'review-error').length, 0)
  assert.ok(named(actions, 'remove-label', 'review-in-progress').length === 1)
  assert.equal(named(actions, 'react-add', 'warning').length, 0, 'still in review — it will be retried')
})

test('a transient failure keeps the Slack ts it just minted', async () => {
  const { deps, actions } = makeDeps({ runReview: async () => { throw new TransientError('429 slow down') } })
  await runCycle({ config, deps, now: NOW })
  const ledger = named(actions, 'comment')[0]
  assert.ok(ledger, 'a ts minted this cycle is only durable once it reaches the sticky comment')
  const written = parseState(ledger[1])
  assert.equal(written.slack.ts, '111.222')
  assert.equal(written.rounds.length, 0, 'a round that never produced a verdict is not a round')
})

test('a usage limit inside the review is transient, not this PR\'s fault', async () => {
  const { deps, actions } = makeDeps({
    runReview: async () => {
      const run = { result: 'Claude AI usage limit reached|1799999999', isError: true, usage: {}, costUsd: 0, durationMs: 3, model: null }
      throw Object.assign(new Error('No JSON object in model output: Claude AI usage limit reached|1799999999'), { run, runs: [run] })
    },
  })
  const out = await runCycle({ config, deps, now: NOW })
  assert.equal(out.aborted, true)
  assert.ok(named(actions, 'add-label', 'review-requested').length === 1)
  assert.equal(named(actions, 'add-label', 'review-error').length, 0)
  assert.equal(named(actions, 'review').length, 0)
})

test('a review timeout is a per-PR failure, never re-queued', async () => {
  const { deps, actions } = makeDeps({
    runReview: async () => { throw new ReviewTimeoutError('claude timed out after 1200000ms (limit 1200000ms) reviewing /wt') },
  })
  const out = await runCycle({ config, deps, now: NOW })
  assert.equal(out.aborted, false)
  assert.equal(out.processed[0].outcome, 'error')
  assert.ok(named(actions, 'add-label', 'review-error').length === 1)
  // An unattended loop retrying a hang forever spends the operator's own
  // subscription quota with nobody watching.
  assert.equal(named(actions, 'add-label', 'review-requested').length, 0)
})

test('per-PR failure sets sticky review-error and continues', async () => {
  const { deps, actions } = makeDeps({
    github: { listOpenPrs: async () => [rawPr({ number: 7 }), rawPr({ number: 8, updated_at: '2026-07-29T19:00:00Z' })] },
    runReview: async ({ pr }) => {
      if (pr.number === 7) throw new Error('verdict unparseable')
      return { verdict: okVerdict(), runs: [RUN] }
    },
  })
  const out = await runCycle({ config, deps, now: NOW })
  assert.equal(out.aborted, false)
  assert.deepEqual(out.processed.map((p) => p.outcome), ['error', 'reviewed'])
  assert.ok(named(actions, 'add-label', 'review-error').length === 1)
  assert.equal(named(actions, 'add-label', 'review-requested').length, 0, 'poison PR must not be re-queued')
})

test('a failed PR stops wearing the in-review reaction', async () => {
  const { deps, actions } = makeDeps({ runReview: async () => { throw new Error('verdict unparseable') } })
  await runCycle({ config, deps, now: NOW })
  assert.ok(named(actions, 'react-remove', 'eyes').length === 1)
  assert.ok(named(actions, 'react-add', 'warning').length === 1)
  // review-error is never auto-retried, so nothing else would ever move it.
  const written = parseState(named(actions, 'comment')[0][1])
  assert.equal(written.slack.stateEmoji, 'warning', 'the next round must know which reaction to clear')
})

test('oversized diff names skipped files and still reviews', async () => {
  const { deps, calls, actions } = makeDeps({
    github: { listPrFiles: async () => ({ files: [
      { filename: 'src/a.ts', additions: 5, deletions: 0, patch: '@@\n+a' },
      { filename: 'pnpm-lock.yaml', additions: 9000, deletions: 0, patch: '@@\n+lock' },
    ], truncated: false }) },
  })
  await runCycle({ config: { ...config, maxDiffLines: 100 }, deps, now: NOW })
  assert.deepEqual(calls.review[0].skippedFiles, ['pnpm-lock.yaml'])
  assert.match(calls.review[0].diff, /src\/a\.ts/, 'the small real file is not crowded out by the lockfile')
  assert.match(bodyOf(actions), /pnpm-lock\.yaml/)
})

test('pagination truncation is named, never silent', async () => {
  const { deps, calls, actions } = makeDeps({
    github: { listPrFiles: async () => ({ files: [{ filename: 'src/a.ts', additions: 1, deletions: 0, patch: '@@\n+a' }], truncated: true }) },
  })
  await runCycle({ config, deps, now: NOW })
  assert.ok(calls.review[0].skippedFiles.some((f) => /pagination/i.test(f)), 'the reviewer is told its view is partial')
  assert.match(bodyOf(actions), /Excluded from this review/)
  assert.match(bodyOf(actions), /pagination/i)
})

test('dry run mutates nothing', async () => {
  const { deps, actions, calls } = makeDeps()
  const out = await runCycle({ config, deps, dryRun: true, now: NOW })
  assert.equal(out.processed[0].outcome, 'dry_run')
  // Not "no labels": no action of any kind, including the reads that cost
  // money — no checkout, no model call, no telemetry row.
  assert.deepEqual(actions, [], 'dry run must touch nothing at all')
  assert.equal(calls.review.length, 0)
  assert.equal(calls.refute.length, 0)
  assert.equal(calls.worktree.length, 0)
  assert.equal(calls.telemetry.length, 0)
})

test('closed PR is skipped without review', async () => {
  const { deps, actions } = makeDeps({ github: { listOpenPrs: async () => [rawPr({ state: 'closed' })] } })
  const out = await runCycle({ config, deps, now: NOW })
  assert.deepEqual(out.processed, [])
  assert.deepEqual(actions, [])
})

test('telemetry records every attempt, tagged with the PR and its round', async () => {
  const runA = { costUsd: 1, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 15000, cache_creation_input_tokens: 3000 }, durationMs: 5, model: 'm1' }
  const runB = { ...runA, costUsd: 2 }
  const verifyRun = { costUsd: 3, usage: { input_tokens: 7, output_tokens: 1 }, durationMs: 9, model: 'm1' }
  const { deps, calls } = makeDeps({
    github: { listIssueComments: async () => [stickyComment(priorState)] },
    runReview: async () => ({ verdict: okVerdict({ findings: [blocking()] }), runs: [runA, runB], run: runB }),
    refuteBlockers: async ({ findings }) => ({ survivors: findings, refuted: [], runs: [verifyRun], degraded: false }),
  })
  await runCycle({ config, deps, now: NOW })

  // Recording only `run` would drop the first attempt — exactly the reviews
  // that cost the most, since a retry is what makes one expensive.
  assert.deepEqual(calls.telemetry.map((r) => r.costUsd), [1, 2, 3])
  assert.deepEqual(calls.telemetry.map((r) => r.phase), ['review', 'review', 'verify'])
  for (const row of calls.telemetry) {
    assert.equal(row.repo, 'o/r')
    assert.equal(row.number, 7)
    // Rows missing these collapse to reviews:1 in summarize(), reporting a
    // whole measurement window as a single review.
    assert.equal(row.round, 2, 'the PR round, never the attempt index')
    assert.equal(row.at, NOW)
  }
  // ~10-18k of cached prompt overhead rides on every call; folding it in would
  // report that fixed overhead as work done on this PR.
  assert.equal(calls.telemetry[0].inputTokens, 10)
  assert.equal(calls.telemetry[0].outputTokens, 2)
  assert.equal(calls.telemetry[0].durationMs, 5)
  assert.equal(calls.telemetry[0].model, 'm1')
})

test('a review that failed still reports what it spent', async () => {
  const { deps, calls } = makeDeps({
    runReview: async () => { throw Object.assign(new Error('verdict unparseable'), { runs: [RUN, RUN] }) },
  })
  await runCycle({ config, deps, now: NOW })
  assert.equal(calls.telemetry.length, 2, 'a failed review is not a free one')
  assert.deepEqual(calls.telemetry.map((r) => r.phase), ['review', 'review'])
  assert.equal(calls.telemetry[0].round, 1)
})

test('a telemetry write failure never costs a completed review', async () => {
  const { deps, actions } = makeDeps({ telemetry: { enabled: true, record: () => { throw new Error('ENOSPC: disk full') } } })
  const out = await runCycle({ config, deps, now: NOW })
  assert.equal(out.processed[0].outcome, 'reviewed')
  assert.ok(named(actions, 'review', 'APPROVE').length === 1)
  assert.equal(named(actions, 'add-label', 'review-error').length, 0)
})

test('refutation gets a five-minute budget; the review keeps its own default', async () => {
  const { deps, calls } = makeDeps({
    runReview: async () => ({ verdict: okVerdict({ findings: [blocking()] }), runs: [RUN] }),
  })
  await runCycle({ config, deps, now: NOW })
  // Worst case is two calls per blocking finding, serial: the 20-minute review
  // default would allow 40 minutes of wall clock per blocker.
  assert.equal(calls.refute[0].timeoutMs, 5 * 60_000)
  assert.equal(calls.review[0].timeoutMs, undefined, 'the review keeps runReview\'s own generous default')
  assert.equal(calls.refute[0].cwd, '/wt', 'the refuter reads the same checkout the review did')
})

test('an author with no Slack mapping is named in a warning', async () => {
  const { deps, actions, logs } = makeDeps({
    runReview: async () => ({ verdict: okVerdict({ findings: [blocking()] }), runs: [RUN] }),
  })
  await runCycle({ config: { ...config, authorMap: {} }, deps, now: NOW })
  // Without this the author is simply never pinged and nobody finds out.
  assert.ok(logs.some((m) => m.includes('octocat')), `no warning naming the author in ${JSON.stringify(logs)}`)
  assert.match(actions.find((a) => a[0] === 'slack-thread')[1], /@octocat/)
})

test('a Slack reaction failure never prevents the GitHub review', async () => {
  const { deps, actions } = makeDeps({ slack: { addReaction: async () => { throw new Error('slack is down') } } })
  const out = await runCycle({ config, deps, now: NOW })
  assert.equal(out.processed[0].outcome, 'reviewed')
  assert.ok(named(actions, 'review', 'APPROVE').length === 1, 'GitHub is the critical path; Slack is best-effort')
  assert.equal(named(actions, 'add-label', 'review-error').length, 0)
})

test('a Slack announcement failure downgrades to no thread and still reviews', async () => {
  const { deps, actions, logs } = makeDeps({ slack: { postMessage: async () => { throw new Error('channel_not_found') } } })
  const out = await runCycle({ config, deps, now: NOW })
  assert.equal(out.processed[0].outcome, 'reviewed')
  assert.ok(named(actions, 'review', 'APPROVE').length === 1)
  assert.equal(named(actions, 'react-add').length, 0, 'no binding, no reactions')
  assert.ok(logs.some((m) => /slack/i.test(m)))
  assert.equal(parseState(named(actions, 'comment')[0][1]).slack, null)
})

test('the worktree is cleaned up even when the review throws', async () => {
  const { deps, actions } = makeDeps({ runReview: async () => { throw new Error('verdict unparseable') } })
  await runCycle({ config, deps, now: NOW })
  assert.ok(named(actions, 'cleanup').length === 1)
})

// GitHub answers 422 "Can not approve your own pull request" to a personal
// token, so a misconfigured installation hits this on its first approval.
const REJECT_422 = 'GitHub POST /repos/o/r/pulls/7/reviews failed (422): Can not approve your own pull request'
const fallbacks = (actions) => actions.filter((a) => a[0] === 'comment' && a[1].includes(REVIEW_FALLBACK_NOTE))

test('a rejected review is preserved as a plain comment, then benched', async () => {
  let sent = null
  const { deps, actions } = makeDeps({
    github: { createReview: async (r, n, x) => { sent = x.body; throw new FatalError(REJECT_422) } },
  })
  const out = await runCycle({ config, deps, now: NOW })

  assert.equal(out.processed[0].outcome, 'error')
  assert.equal(out.aborted, false, '422 is deterministic — the rest of the cycle is fine')
  assert.ok(named(actions, 'add-label', 'review-error').length === 1, 'sticky, as with any per-PR failure')
  assert.equal(named(actions, 'add-label', 'review-requested').length, 0, 'retrying a 422 cannot succeed')
  const preserved = fallbacks(actions)
  assert.equal(preserved.length, 1, 'the most expensive artifact this pipeline makes must not be dropped')
  // Content, not merely presence: a stub posting an empty string would sail
  // through "some comment was posted".
  assert.ok(sent && preserved[0][1].includes(sent), 'the same rendered body that the review POST carried')
  assert.match(preserved[0][1], /## ✅ Approved — Round 1/)
})

test('when preserving the review also fails, neither failure is lost', async () => {
  const { deps, actions, logs } = makeDeps({
    github: {
      createReview: async () => { throw new FatalError(REJECT_422) },
      createIssueComment: async () => { throw new FatalError('GitHub POST /repos/o/r/issues/7/comments failed (403): Resource not accessible by integration') },
    },
  })
  const out = await runCycle({ config, deps, now: NOW })

  assert.equal(out.processed[0].outcome, 'error')
  assert.ok(named(actions, 'add-label', 'review-error').length === 1, 'the label lands even when both writes fail')
  const reported = logs.find((m) => m.includes('Can not approve your own pull request'))
  assert.ok(reported, `nothing reported the rejected review: ${JSON.stringify(logs)}`)
  // The fallback's own failure must not stand in for the rejection that caused
  // it — that cause is the one useful fact for whoever clears the sticky label.
  assert.match(reported, /403/)
  assert.match(reported, /422/)
})

test('a transient review rejection is retried next cycle, never preserved', async () => {
  const { deps, actions } = makeDeps({
    github: { createReview: async () => { throw new TransientError('GitHub POST /repos/o/r/pulls/7/reviews failed (502): bad gateway') } },
  })
  const out = await runCycle({ config, deps, now: NOW })

  assert.equal(out.aborted, true)
  assert.ok(named(actions, 'add-label', 'review-requested').length === 1)
  assert.equal(named(actions, 'add-label', 'review-error').length, 0)
  // The retry will post the review properly; a fallback comment now would
  // leave the findings on the PR twice.
  assert.equal(fallbacks(actions).length, 0)
})

test('a successful review posts no fallback comment', async () => {
  const { deps, actions } = makeDeps()
  await runCycle({ config, deps, now: NOW })

  assert.ok(named(actions, 'review', 'APPROVE').length === 1)
  assert.equal(fallbacks(actions).length, 0, 'every clean review would otherwise double-post')
  const comments = named(actions, 'comment')
  assert.equal(comments.length, 1, 'round 1 writes exactly one comment')
  assert.ok(parseState(comments[0][1]), 'and it is the ledger, not a copy of the review')
})

test('maxPerCycle is a whole-cycle budget, spent oldest-first across every repo', async () => {
  const inRepo = (repo, number, minute) => rawPr({ number, updated_at: `2026-07-29T18:0${minute}:00Z`, base: { repo: { full_name: repo } } })
  const byRepo = {
    'o/a': [inRepo('o/a', 1, 1), inRepo('o/a', 2, 4)],
    'o/b': [inRepo('o/b', 3, 2), inRepo('o/b', 4, 3)],
  }
  const { deps, calls } = makeDeps({ github: { listOpenPrs: async (repo) => byRepo[repo] } })
  const out = await runCycle({ config: { ...config, repos: ['o/a', 'o/b'], maxPerCycle: 3 }, deps, now: NOW })

  // selectPrs already caps within a repo, so the only thing this can be
  // testing is the cross-repo behaviour: two repos of two, a budget of three.
  assert.equal(out.processed.length, 3, 'the cap is a per-cycle budget, not a per-repo one')
  assert.deepEqual(out.processed.map((p) => `${p.repo}#${p.number}`), ['o/a#1', 'o/b#3', 'o/b#4'],
    'oldest first across all repos — a busy first repo must not starve a later one')
  assert.equal(calls.review.length, 3)
})
