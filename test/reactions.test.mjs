import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planReactionChange, resolveMention } from '../src/reactions.mjs'

const emoji = { inReview: 'eyes', approved: 'white_check_mark', changesRequested: 'x' }

test('first verdict adds and removes nothing', () => {
  assert.deepEqual(planReactionChange({ previous: null, verdict: 'changes_requested', emoji }), { remove: null, add: 'x', next: 'x' })
})

test('flipping verdict removes the stale reaction — no contradictory pair', () => {
  assert.deepEqual(planReactionChange({ previous: 'x', verdict: 'approved', emoji }), { remove: 'x', add: 'white_check_mark', next: 'white_check_mark' })
})

test('repeating the same verdict is a no-op', () => {
  assert.deepEqual(planReactionChange({ previous: 'x', verdict: 'changes_requested', emoji }), { remove: null, add: null, next: 'x' })
})

test('in-review clears a previous verdict reaction', () => {
  assert.deepEqual(planReactionChange({ previous: 'white_check_mark', verdict: 'in_review', emoji }), { remove: 'white_check_mark', add: 'eyes', next: 'eyes' })
})

test('resolveMention prefers the explicit author map', async () => {
  // A throwing lookupEmail alone does not prove preference. It needs an email
  // to be reached at all, and even then the reversed chain swallows the throw
  // and returns the mapped ID anyway — so both mutations pass unless the test
  // observes that no lookup happened. Verified by mutation; see task-6-report.md.
  let called = false
  const lookupEmail = async () => {
    called = true
    throw new Error('must not be called')
  }
  const out = await resolveMention({ login: 'octocat', authorMap: { octocat: 'U1' }, email: 'a@b.c', lookupEmail })
  assert.deepEqual(out, { text: '<@U1>', mapped: true })
  assert.equal(called, false, 'a mapped author must not cost a Slack round-trip')
})

test('resolveMention falls back to Slack email lookup', async () => {
  const out = await resolveMention({ login: 'octocat', authorMap: {}, email: 'a@b.c', lookupEmail: async () => 'U2' })
  assert.deepEqual(out, { text: '<@U2>', mapped: true })
})

test('resolveMention degrades to unlinked text rather than failing', async () => {
  const out = await resolveMention({ login: 'octocat', authorMap: {}, lookupEmail: async () => { throw new Error('not_found') } })
  assert.deepEqual(out, { text: '`@octocat`', mapped: false })
})

// The test above has no email, so the lookup is never reached and its rejection
// is never observed. This one reaches it: the review is already posted on
// GitHub by the time we mention anyone, so a Slack API failure must not throw.
test('resolveMention swallows a rejecting Slack lookup', async () => {
  const out = await resolveMention({ login: 'octocat', authorMap: {}, email: 'a@b.c', lookupEmail: async () => { throw new Error('users_not_found') } })
  assert.deepEqual(out, { text: '`@octocat`', mapped: false })
})

test('resolveMention degrades when Slack knows nobody at that address', async () => {
  // A resolved-but-empty lookup is the common case: the author's GitHub email
  // is a noreply alias, so Slack returns no member rather than an error.
  const out = await resolveMention({ login: 'octocat', authorMap: {}, email: 'a@b.c', lookupEmail: async () => null })
  assert.deepEqual(out, { text: '`@octocat`', mapped: false })
})

test('a login colliding with an Object.prototype key is not mentioned as one', async () => {
  // `constructor` and `toString` are registered GitHub logins. Truthiness on
  // authorMap[login] would inherit from Object.prototype and mention a function.
  const out = await resolveMention({ login: 'constructor', authorMap: {} })
  assert.deepEqual(out, { text: '`@constructor`', mapped: false })
})
