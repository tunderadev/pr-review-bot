import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPrs, normalizePr, prsBlockedByError } from '../src/discover.mjs'

const config = {
  titlePrefix: '^\\[PLAT\\]',
  labels: { requested: 'review-requested', error: 'review-error' },
  maxPerCycle: 2,
}

const raw = (over = {}) => ({
  number: 1,
  title: '[PLAT] add widget',
  state: 'open',
  draft: false,
  updated_at: '2026-07-29T10:00:00Z',
  html_url: 'https://github.com/o/r/pull/1',
  user: { login: 'octocat' },
  head: { sha: 'aaa111' },
  base: { repo: { full_name: 'o/r' } },
  labels: [{ name: 'review-requested' }],
  ...over,
})

test('normalizePr flattens the fields later tasks need', () => {
  assert.deepEqual(normalizePr(raw()), {
    repo: 'o/r', number: 1, title: '[PLAT] add widget', author: 'octocat',
    headSha: 'aaa111', url: 'https://github.com/o/r/pull/1', draft: false,
    updatedAt: '2026-07-29T10:00:00Z',
  })
})

// A deleted GitHub account arrives as user: null. Dereferencing it threw a
// TypeError out of discovery itself, which runs before any PR is claimed — so
// one deleted account stopped every repo from being looked at.
test('a PR whose author account is gone is still reviewable', () => {
  const orphan = raw({ number: 1, user: null })
  assert.equal(normalizePr(orphan).author, null)
  assert.deepEqual(selectPrs([orphan], config).map((p) => p.number), [1])
})

test('a payload with no base repository is dropped instead of crashing discovery', () => {
  const prs = [raw({ number: 1, base: {} }), raw({ number: 2, base: { repo: null } }), raw({ number: 3, head: null }), raw({ number: 4 })]
  assert.equal(normalizePr(prs[0]).repo, null)
  // There is no repository to address and no commit to check out, so there is
  // nothing a review could be run against — but the OTHER PRs must still be.
  assert.deepEqual(selectPrs(prs, config).map((p) => p.number), [4])
})

test('selects only labeled, prefix-matching, open PRs', () => {
  const prs = [
    raw({ number: 1 }),
    raw({ number: 2, labels: [] }),
    raw({ number: 3, title: 'add widget' }),
    raw({ number: 4, state: 'closed' }),
  ]
  assert.deepEqual(selectPrs(prs, config).map((p) => p.number), [1])
})

test('drafts are reviewed — the label is explicit opt-in', () => {
  assert.equal(selectPrs([raw({ draft: true })], config).length, 1)
})

// review-error is terminal by contract: it is applied when a human has to look
// and no automation ever removes it. Selecting a PR that wears it means the
// cycle fails on it again, re-applies the label, and does that forever — and a
// human who clears the label gets it back on the next poll.
test('a PR wearing review-error is never selected, however it got the trigger label', () => {
  const prs = [
    raw({ number: 1, labels: [{ name: 'review-requested' }, { name: 'review-error' }] }),
    raw({ number: 2, labels: [{ name: 'review-error' }] }),
    raw({ number: 3 }),
  ]
  assert.deepEqual(selectPrs(prs, config).map((p) => p.number), [3])
})

test('the documented recovery works: clear review-error, re-add review-requested', () => {
  const stuck = raw({ number: 1, labels: [{ name: 'review-requested' }, { name: 'review-error' }] })
  assert.equal(selectPrs([stuck], config).length, 0)
  const cleared = { ...stuck, labels: [{ name: 'review-requested' }] }
  assert.deepEqual(selectPrs([cleared], config).map((p) => p.number), [1], 'a human clearing the label must get a review')
})

test('a PR asking for a re-review while still benched is reported, never silently dropped', () => {
  const prs = [
    raw({ number: 1, labels: [{ name: 'review-requested' }, { name: 'review-error' }] }),
    // Benched but not re-requested: nobody is waiting on it, so it is not news.
    raw({ number: 2, labels: [{ name: 'review-error' }] }),
    raw({ number: 3 }),
  ]
  assert.deepEqual(prsBlockedByError(prs, config).map((p) => p.number), [1])
})

test('orders oldest-updated first and caps at maxPerCycle', () => {
  const prs = [
    raw({ number: 1, updated_at: '2026-07-29T12:00:00Z' }),
    raw({ number: 2, updated_at: '2026-07-29T09:00:00Z' }),
    raw({ number: 3, updated_at: '2026-07-29T11:00:00Z' }),
  ]
  assert.deepEqual(selectPrs(prs, config).map((p) => p.number), [2, 3])
})
