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

test('parseState ignores quoted marker text and parses the real block', () => {
  const stateForBlock = {
    version: STATE_VERSION,
    slack: null,
    criteriaVersion: null,
    rounds: [{ round: 1, sha: 'def5678', verdict: 'approved', at: '2026-07-29T19:00:00Z', blockers: [] }],
  }
  const renderedBlock = renderStateComment(stateForBlock)
  // Simulate a quoted prior comment containing the marker
  const bodyWithQuotedMarker = `> Previous review:
> <!-- pr-review-bot:state
> {"version":1}
> -->

${renderedBlock}`
  assert.deepEqual(parseState(bodyWithQuotedMarker), stateForBlock)
})
