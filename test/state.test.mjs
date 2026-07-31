import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseState, renderStateComment, findSticky, appendRound, alreadyReviewedSha, emptyState, lastRound, STATE_VERSION } from '../src/state.mjs'

const state = {
  version: STATE_VERSION,
  slack: { channel: 'C1', ts: '1712345678.123456', stateEmoji: 'x' },
  criteriaVersion: 'sha256:ab12',
  rounds: [{ round: 1, sha: 'abc1234', verdict: 'changes_requested', at: '2026-07-29T18:00:00Z', blockers: [{ file: 'src/a.ts', line: 42, claim: 'unhandled null' }] }],
}

test('render then parse round-trips exactly', () => {
  assert.deepEqual(parseState(renderStateComment(state)), state)
})

test('rendered comment is human-readable above the hidden block', () => {
  const body = renderStateComment(state)
  assert.match(body, /Claude review ledger/)
  assert.match(body, /changes requested/i)
  assert.match(body, /<!-- pr-review-bot:state/)
})

test('parseState returns null for absent, unmarked, malformed, or future-version bodies', () => {
  assert.equal(parseState(undefined), null)
  assert.equal(parseState('just a comment'), null)
  assert.equal(parseState('<!-- pr-review-bot:state\n{not json\n-->'), null)
  assert.equal(parseState('<!-- pr-review-bot:state\n{"version":99}\n-->'), null)
})

test('findSticky matches only the bot comment carrying the marker', () => {
  const comments = [
    { id: 1, user: { login: 'octocat' }, body: renderStateComment(state) },
    { id: 2, user: { login: 'plat-reviewer[bot]' }, body: 'nice work' },
    { id: 3, user: { login: 'plat-reviewer[bot]' }, body: renderStateComment(state) },
  ]
  assert.equal(findSticky(comments, 'plat-reviewer[bot]').id, 3)
  assert.equal(findSticky([], 'plat-reviewer[bot]'), null)
})

test('appendRound increments and does not mutate the input', () => {
  const next = appendRound(state, { sha: 'def5678', verdict: 'approved', at: '2026-07-29T19:00:00Z', blockers: [] })
  assert.equal(next.rounds.length, 2)
  assert.equal(next.rounds[1].round, 2)
  assert.equal(state.rounds.length, 1)
  assert.equal(lastRound(next).verdict, 'approved')
})

test('emptyState has no slack binding and no rounds', () => {
  assert.deepEqual(emptyState(), { version: STATE_VERSION, slack: null, criteriaVersion: null, rounds: [] })
  assert.equal(lastRound(emptyState()), null)
})

test('alreadyReviewedSha matches bot reviews at that exact head SHA', () => {
  const reviews = [
    { user: { login: 'plat-reviewer[bot]' }, commit_id: 'abc1234', state: 'CHANGES_REQUESTED' },
    { user: { login: 'someone' }, commit_id: 'def5678', state: 'APPROVED' },
    { user: { login: 'plat-reviewer[bot]' }, commit_id: 'ghi9999', state: 'PENDING' },
  ]
  assert.equal(alreadyReviewedSha(reviews, 'plat-reviewer[bot]', 'abc1234'), true)
  assert.equal(alreadyReviewedSha(reviews, 'plat-reviewer[bot]', 'def5678'), false)
  assert.equal(alreadyReviewedSha(reviews, 'plat-reviewer[bot]', 'ghi9999'), false, 'PENDING is not a submitted review')
})

test('parseState survives blocker claims containing the end marker -->', () => {
  const stateWithArrow = {
    version: STATE_VERSION,
    slack: { channel: 'C1', ts: '1712345678.123456', stateEmoji: 'x' },
    criteriaVersion: 'sha256:ab12',
    rounds: [{ round: 1, sha: 'abc1234', verdict: 'changes_requested', at: '2026-07-29T18:00:00Z', blockers: [{ file: 'src/guard.ts', line: 15, claim: 'guard is if (x) --> return null unexpectedly' }] }],
  }
  assert.deepEqual(parseState(renderStateComment(stateWithArrow)), stateWithArrow)
})

// A markdown quote of a comment this tool actually rendered — base64 payload
// and all. Node's base64 decoder silently discards the "> " prefixes, so a
// quoted block decodes cleanly and is caught only by the BASE64_ONLY guard.
const quote = (text) => text.split('\n').map((line) => `> ${line}`).join('\n')

const OTHER_STATE = {
  version: STATE_VERSION,
  slack: { channel: 'C-OTHER', ts: '1600000000.000000', stateEmoji: 'eyes' },
  criteriaVersion: 'sha256:ffff',
  rounds: [{ round: 1, sha: 'def5678', verdict: 'approved', at: '2026-07-29T19:00:00Z', blockers: [] }],
}

test('parseState ignores a quoted post-base64 block preceding the real one', () => {
  const stateForBlock = {
    version: STATE_VERSION,
    slack: null,
    criteriaVersion: null,
    rounds: [{ round: 1, sha: 'def5678', verdict: 'approved', at: '2026-07-29T19:00:00Z', blockers: [] }],
  }
  const body = `> Previous review:\n${quote(renderStateComment(OTHER_STATE))}\n\n${renderStateComment(stateForBlock)}`
  assert.deepEqual(parseState(body), stateForBlock)
})

const QUOTED_BLOCK = `> Previous review:\n${quote(renderStateComment(OTHER_STATE))}`

function stateWithClaim(claim) {
  return {
    version: STATE_VERSION,
    slack: { channel: 'C1', ts: '1712345678.123456', stateEmoji: 'x' },
    criteriaVersion: 'sha256:ab12',
    rounds: [{ round: 1, sha: 'abc1234', verdict: 'changes_requested', at: '2026-07-29T18:00:00Z', blockers: [{ file: 'src/a.ts', line: 42, claim }] }],
  }
}

test('parseState survives a blocker claim containing the start marker itself', () => {
  // The claim is LLM prose about code the PR author controls, so it can contain
  // anything — including this tool's own opening delimiter.
  const hostile = stateWithClaim('template literal emits <!-- pr-review-bot:state into the page')
  assert.deepEqual(parseState(renderStateComment(hostile)), hostile)
})

test('parseState survives text appended after the hidden block', () => {
  const body = `${renderStateComment(state)}\n\n<!-- a human edited this sticky comment -->\nPlease also check the migration.`
  assert.deepEqual(parseState(body), state)
})

test('parseState ignores a quoted marker appended after the real block', () => {
  const body = `${renderStateComment(state)}\n\n${QUOTED_BLOCK}`
  assert.deepEqual(parseState(body), state)
})

test('the hidden block payload cannot contain a comment delimiter', () => {
  const hostile = stateWithClaim('guard is if (x) --> return null; see <!-- pr-review-bot:state -->')
  const body = renderStateComment(hostile)
  const start = body.indexOf('<!-- pr-review-bot:state') + '<!-- pr-review-bot:state'.length
  const payload = body.slice(start, body.indexOf('-->', start)).trim()
  assert.match(payload, /^[A-Za-z0-9+/=]+$/, 'payload must be base64 — structurally unable to hold a delimiter')
})

test('parseState returns null for an unknown version inside a well-formed block', () => {
  const encoded = Buffer.from(JSON.stringify({ version: 99, rounds: [] })).toString('base64')
  assert.equal(parseState(`<!-- pr-review-bot:state\n${encoded}\n-->`), null)
})

const block = (payloadObject) =>
  `<!-- pr-review-bot:state\n${Buffer.from(JSON.stringify(payloadObject)).toString('base64')}\n-->`

test('parseState reads the FIRST decodable block, so an appended one cannot take over', () => {
  // Anyone who can edit the sticky comment can append a block of their own.
  // Reading the last one lets it replace the bot's own memory: a forged Slack
  // binding redirects every future update into a channel of their choosing.
  const forged = { version: STATE_VERSION, slack: { channel: 'ATTACKER', ts: '1.1' }, criteriaVersion: null, rounds: [] }
  const body = `${renderStateComment(state)}\n\n${block(forged)}`
  assert.deepEqual(parseState(body), state, 'the bot-written block comes first and must win')
})

test('re-pasting an older sticky body below the current one does not roll history back', () => {
  // Rolling back to round 1 makes the bot re-announce and re-review work it
  // has already reviewed, at the author's expense.
  const older = { ...state, rounds: state.rounds.slice(0, 1) }
  const newer = appendRound(older, { sha: 'def5678', verdict: 'approved', at: '2026-07-29T20:00:00Z', blockers: [] })
  const body = `${renderStateComment(newer)}\n\n---\nFor reference, the previous version of this comment:\n\n${renderStateComment(older)}`
  assert.deepEqual(parseState(body), newer)
  assert.equal(parseState(body).rounds.length, 2)
})

test('a corrupted real block returns null rather than falling back to another block', () => {
  // Healing from emptyState is recoverable; adopting someone else's state is not.
  const real = renderStateComment(state)
  const corrupted = real.slice(0, real.length - 12) + '\n-->'
  const body = `${QUOTED_BLOCK}\n\n${corrupted}`
  assert.equal(parseState(body), null)
})

test('parseState returns null for a version-correct payload of the wrong shape', () => {
  // lastRound, appendRound and renderLedger all dereference these. A raw
  // TypeError is not a TransientError, so it applies the sticky review-error
  // label that is never auto-retried — over a comment the bot can just rebuild.
  const wrongShapes = [
    { version: STATE_VERSION },
    { version: STATE_VERSION, rounds: 'nope' },
    { version: STATE_VERSION, rounds: {} },
    { version: STATE_VERSION, rounds: [], slack: 'C0123ABC' },
    { version: STATE_VERSION, rounds: [], slack: [] },
    { version: STATE_VERSION, rounds: [null] },
    { version: STATE_VERSION, rounds: [{ round: 1, sha: 'abc1234', verdict: 'approved', at: 'now' }] },
    { version: STATE_VERSION, rounds: [{ round: 1, verdict: 'approved', at: 'now', blockers: [] }] },
  ]
  for (const payload of wrongShapes) {
    assert.equal(parseState(block(payload)), null, `accepted ${JSON.stringify(payload)}`)
  }
  assert.equal(parseState(2), null, 'a non-string body is not a comment')
  assert.equal(parseState('<!-- pr-review-bot:state\n\n-->'), null, 'an empty payload is not state')
  assert.equal(parseState(`<!-- pr-review-bot:state\n${Buffer.from('{"version":1,"rounds":[]').toString('base64')}\n-->`), null, 'truncated JSON')
})

test('a shape-valid payload still round-trips, including a state with no rounds', () => {
  assert.deepEqual(parseState(renderStateComment(emptyState())), emptyState())
  assert.deepEqual(parseState(renderStateComment(OTHER_STATE)), OTHER_STATE)
})
