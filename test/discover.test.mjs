import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPrs, normalizePr } from '../src/discover.mjs'

const config = {
  titlePrefix: '^\\[PLAT\\]',
  labels: { requested: 'review-requested' },
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

test('orders oldest-updated first and caps at maxPerCycle', () => {
  const prs = [
    raw({ number: 1, updated_at: '2026-07-29T12:00:00Z' }),
    raw({ number: 2, updated_at: '2026-07-29T09:00:00Z' }),
    raw({ number: 3, updated_at: '2026-07-29T11:00:00Z' }),
  ]
  assert.deepEqual(selectPrs(prs, config).map((p) => p.number), [2, 3])
})
