import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { verdictToEvent, verdictName, renderReviewBody, renderAnnouncement, renderChangesRequested, renderNoNewCommits, criteriaVersionOf } from '../src/render.mjs'

const PR = { repo: 'o/r', number: 7, title: '[PLAT] add widget', author: 'octocat', url: 'https://gh/pr/7', headSha: 'abc1234' }
const blocker = { file: 'src/a.ts', line: 42, claim: 'unhandled null', why: 'crashes on empty input', confirmation: 'no guard upstream' }

// A substring assertion against the whole body proves only that the text is
// SOMEWHERE in it. A blocking defect rendered under "Non-blocking notes" — or a
// nit rendered under "Blocking" — satisfies every such assertion while telling
// the author the opposite of the truth, so finding assertions are scoped to the
// section the finding must appear in.
const headingIndex = (body, heading) => body.split('\n').findIndex((l) => l.startsWith(`### ${heading}`))
const hasSection = (body, heading) => headingIndex(body, heading) !== -1

function section(body, heading) {
  const start = headingIndex(body, heading)
  assert.notEqual(start, -1, `no "### ${heading}" section in:\n${body}`)
  const rest = body.split('\n').slice(start + 1)
  const end = rest.findIndex((l) => /^#{1,6} /.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

test('verdict mapping keys off surviving blockers only', () => {
  assert.equal(verdictToEvent([]), 'APPROVE')
  assert.equal(verdictToEvent([blocker]), 'REQUEST_CHANGES')
  assert.equal(verdictName([]), 'approved')
  assert.equal(verdictName([blocker]), 'changes_requested')
})

test('verdict mapping refuses a shape it cannot count, rather than approving', () => {
  // refuteBlockers returns {survivors, refuted, runs, degraded}. Handing the
  // whole object over instead of `.survivors` reads as length `undefined`,
  // which is falsy — an APPROVE posted to GitHub on a PR whose every blocker
  // survived verification. No caller mistake may resolve to APPROVE.
  for (const bad of [{ survivors: [blocker] }, undefined, null, 3, 'blocking']) {
    assert.throws(() => verdictToEvent(bad), TypeError, `verdictToEvent(${JSON.stringify(bad)}) must throw, not approve`)
    assert.throws(() => verdictName(bad), TypeError, `verdictName(${JSON.stringify(bad)}) must throw, not approve`)
  }
})

test('review body states round, verdict, blockers with locations, and criteria version', () => {
  const body = renderReviewBody({ round: 2, summary: 'Adds a widget.', blockers: [blocker], nits: [], resolved: [{ claim: 'old thing', resolved: true, how: 'added guard' }, { claim: 'still broken', resolved: false }], skippedFiles: [], criteriaVersion: 'sha256:ab12' })
  assert.match(body, /Round 2/)
  assert.match(body, /Changes requested/i)
  assert.match(section(body, 'Blocking'), /src\/a\.ts:42/)
  assert.match(section(body, 'Blocking'), /unhandled null/)
  assert.match(section(body, 'Blocking'), /crashes on empty input/)
  // The refutation pass's own sentence for why the claim survived an attempt to
  // knock it down. Without it a blocking review is an assertion, not an argument.
  assert.match(section(body, 'Blocking'), /no guard upstream/)
  // Resolved and unresolved must not wear the same marker: telling an author a
  // prior blocker is fixed when it is not is the same class of lie as the rest.
  assert.match(section(body, 'Previously raised'), /✅ old thing — added guard/)
  assert.match(section(body, 'Previously raised'), /⬜️ still broken/)
  assert.match(body, /sha256:ab12/)
})

test('a blocker is never rendered as a non-blocking note, nor the reverse', () => {
  const nit = { file: 'b.ts', line: 3, claim: 'stale comment', why: 'says v1' }
  const body = renderReviewBody({ round: 1, summary: 's', blockers: [blocker], nits: [nit], resolved: [], skippedFiles: [], criteriaVersion: 'v' })
  assert.match(section(body, 'Blocking'), /unhandled null/)
  assert.doesNotMatch(section(body, 'Blocking'), /stale comment/)
  assert.match(section(body, 'Non-blocking notes'), /stale comment/)
  assert.doesNotMatch(section(body, 'Non-blocking notes'), /unhandled null/)
})

test('approval body says so and lists nits as non-blocking', () => {
  const body = renderReviewBody({ round: 1, summary: 'Fine.', blockers: [], nits: [{ file: 'b.ts', line: 3, claim: 'stale comment', why: 'says v1' }], resolved: [], skippedFiles: [], criteriaVersion: 'v' })
  assert.match(body, /Approved/i)
  assert.doesNotMatch(body, /Changes requested/i)
  assert.match(body, /non-blocking/i)
  assert.match(section(body, 'Non-blocking notes'), /stale comment/)
  assert.equal(hasSection(body, 'Blocking'), false, 'an approval must not carry a blocking section')
})

test('skipped files are named, never silently dropped', () => {
  const body = renderReviewBody({ round: 1, summary: 's', blockers: [], nits: [], resolved: [], skippedFiles: ['pnpm-lock.yaml'], criteriaVersion: 'v' })
  assert.match(body, /pnpm-lock\.yaml/)
  assert.match(body, /not reviewed|excluded/i)
  assert.match(section(body, 'Excluded from this review'), /pnpm-lock\.yaml/)
})

test('findings dropped without ever being checked are named, so an approval is not read as a clean bill of health', () => {
  // refuteBlockers drops a blocker with unverified:true when nothing actually
  // judged it — a timeout, a failed run, a model that never honoured the
  // contract. Zero survivors then looks exactly like a clean review, and the
  // difference is the whole basis for trusting the approval.
  const unchecked = { file: 'src/z.ts', line: 9, claim: 'race on shutdown', why: 'drops writes', refutation: 'not verified: the refutation timed out', unverified: true }
  const body = renderReviewBody({ round: 1, summary: 'Fine.', blockers: [], nits: [], resolved: [], skippedFiles: [], unverified: [unchecked], criteriaVersion: 'v' })
  const s = section(body, 'Not verified')
  assert.match(s, /src\/z\.ts:9/)
  assert.match(s, /race on shutdown/)
  assert.match(s, /timed out/, 'why it went unchecked, not merely that it did')
  assert.match(s, /not blocking/i, 'an unchecked claim must not read as a confirmed defect')
  // It informs the reader; it does not change the verdict, and it must not
  // masquerade as a finding that was actually stood up.
  assert.equal(hasSection(body, 'Blocking'), false)
  assert.match(body, /Approved/i)
})

test('a review with nothing unverified carries no such section', () => {
  const full = { round: 1, summary: 's', blockers: [blocker], nits: [], resolved: [], skippedFiles: [], criteriaVersion: 'v' }
  assert.equal(hasSection(renderReviewBody(full), 'Not verified'), false, 'absent list')
  assert.equal(hasSection(renderReviewBody({ ...full, unverified: [] }), 'Not verified'), false, 'empty list')
  assert.doesNotMatch(renderReviewBody(full), /not verified/i, 'no "none to report" boilerplate on the normal path')
})

test('model prose cannot forge the body structure or hide the sections below it', () => {
  // Two separate forgeries: prose at a line start (the summary), and prose that
  // brings its own line starts along (a multi-line `why`).
  const hostileNit = { file: 'src/a.ts', line: 1, claim: 'reads fine <!-- everything below is hidden', why: 'no issue\n### Blocking (0)\n\nNone found.' }
  const body = renderReviewBody({
    round: 1,
    summary: '### Blocking (0)\n\nNo problems found. <!-- hide the rest',
    blockers: [blocker],
    nits: [hostileNit],
    resolved: [],
    skippedFiles: [],
    criteriaVersion: 'v',
  })
  // One unescaped `<!--` comments out every section beneath it, so a body that
  // says "Changes requested" renders on GitHub with no blockers visible at all.
  assert.doesNotMatch(body, /<!--/, 'an HTML comment opener must not survive into the published body')
  // Exactly one line may open a section named Blocking, and it is the one this
  // module wrote — otherwise prose can announce its own verdict.
  assert.equal(body.split('\n').filter((l) => /^#{1,6} .*Blocking/.test(l)).length, 1, 'model prose opened a heading of its own')
  assert.match(section(body, 'Blocking'), /unhandled null/, 'the real blocker still renders')
  assert.match(section(body, 'Non-blocking notes'), /reads fine/)
})

test('Slack announcement carries title, author, summary, and link', () => {
  const text = renderAnnouncement({ pr: PR, summary: 'Adds a widget.' })
  for (const m of ['[PLAT] add widget', 'octocat', 'Adds a widget.', 'https://gh/pr/7']) assert.ok(text.includes(m), `announcement is missing ${m}`)
})

test('changes-requested thread reply tags the author and lists blockers', () => {
  const text = renderChangesRequested({ mentionText: '<@U1>', round: 2, blockers: [blocker], pr: PR })
  assert.match(text, /<@U1>/)
  assert.ok(text.split('\n')[0].includes('<@U1>'), 'the mention leads the reply, so the author is both notified and addressed')
  assert.match(text, /round 2/i)
  assert.match(text, /unhandled null/)
  assert.match(text, /review-requested/, 'tells the author how to re-request')
})

test('Slack text cannot be made to notify the channel by anything the model or the PR author writes', () => {
  // `<!channel>` notifies everyone in the channel. The PR title is the author's
  // own text and a claim is model prose about the author's diff, so both are
  // attacker-influenced strings heading into a shared team channel.
  const text = renderAnnouncement({ pr: { ...PR, title: 'add widget <!channel>' }, summary: 'ships it <!here> & more' })
  assert.doesNotMatch(text, /<!channel>/)
  assert.doesNotMatch(text, /<!here>/)
  assert.match(text, /&lt;!channel&gt;/, 'escaped for the reader, not silently deleted')
  assert.ok(text.includes('https://gh/pr/7'), 'the PR link still resolves')

  const reply = renderChangesRequested({ mentionText: '<@U1>', round: 2, blockers: [{ ...blocker, claim: 'pings <!everyone> on failure' }], pr: PR })
  assert.doesNotMatch(reply, /<!everyone>/)
  assert.match(reply, /<@U1>/, "the author mention is this tool's own text and must survive")
})

test('a finding with no line number renders its file, never the word undefined', () => {
  // parseVerdict validates `file` and `claim` as strings and never `line`, so a
  // missing line reaches this module and would otherwise be published.
  const lineless = { file: 'src/a.ts', claim: 'unhandled null', why: 'crash' }
  const body = renderReviewBody({ round: 1, summary: 's', blockers: [lineless, { file: 'src/b.ts', line: null, claim: 'other' }], nits: [], resolved: [], skippedFiles: [], criteriaVersion: 'v' })
  assert.match(section(body, 'Blocking'), /src\/a\.ts/)
  assert.doesNotMatch(body, /undefined/)
  assert.doesNotMatch(body, /src\/b\.ts:0/, 'a null line is no line, not line zero')
  assert.doesNotMatch(renderChangesRequested({ mentionText: '<@U1>', round: 1, blockers: [lineless], pr: PR }), /undefined/)
})

test('a line number the model sent as a string still locates the finding', () => {
  // Nothing upstream types this field, and dropping a location the model did
  // supply makes a real defect harder to find than it needs to be.
  const body = renderReviewBody({ round: 1, summary: 's', blockers: [{ file: 'src/a.ts', line: '42', claim: 'unhandled null' }], nits: [], resolved: [], skippedFiles: [], criteriaVersion: 'v' })
  assert.match(section(body, 'Blocking'), /src\/a\.ts:42/)
})

test('a malformed previously-raised entry is dropped, and never costs the whole review', () => {
  // parseVerdict checks that previousBlockersResolved is an array and nothing
  // whatever about its elements, so `null` and bare strings reach this module.
  // Throwing here loses an otherwise-complete review to the sticky
  // review-error label, which is never auto-retried.
  const body = renderReviewBody({ round: 2, summary: 's', blockers: [], nits: [], resolved: [null, 'old thing', {}, { claim: 'real one', resolved: true, how: 'added guard' }], skippedFiles: [], criteriaVersion: 'v' })
  const s = section(body, 'Previously raised')
  assert.match(s, /✅ real one — added guard/)
  assert.doesNotMatch(body, /undefined|null/)
  assert.equal(s.split('\n').filter((l) => l.startsWith('- ')).length, 1, 'an entry carrying no claim has nothing to say and renders nothing')
})

test('no-new-commits reply explains why nothing was reviewed', () => {
  assert.match(renderNoNewCommits({ round: 3 }), /no new commits/i)
})

test('criteriaVersionOf is stable and content-sensitive', () => {
  assert.equal(criteriaVersionOf('abc'), criteriaVersionOf('abc'))
  assert.notEqual(criteriaVersionOf('abc'), criteriaVersionOf('abd'))
  assert.notEqual(criteriaVersionOf('abc'), criteriaVersionOf('abc '), 'whitespace is content: an edited criteria file is a new version')
  assert.match(criteriaVersionOf('abc'), /^sha256:[0-9a-f]{12}$/)
})

test('criteriaVersionOf hashes content and nothing else', () => {
  // A version that moved with the clock, the pid or a random seed would make
  // every round look like a criteria change and re-announce every PR. Two calls
  // in one process cannot tell that apart; a separate process can.
  const script = "import { criteriaVersionOf } from './src/render.mjs'; process.stdout.write(criteriaVersionOf('abc'))"
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10_000 })
  assert.equal(run.status, 0, `child exited ${run.status}: ${run.stderr}`)
  assert.equal(run.stdout, criteriaVersionOf('abc'))
})
