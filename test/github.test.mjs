import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGitHub, classifyStatus, TransientError, FatalError } from '../src/github.mjs'

function stubFetch(responses) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    const next = responses.shift() ?? { ok: true, status: 200, json: async () => ({}) }
    return { text: async () => '', json: async () => ({}), ...next }
  }
  return { impl, calls }
}

test('classifyStatus treats 429, 5xx, and rate-limit 403 as transient', () => {
  assert.equal(classifyStatus(429, ''), 'transient')
  assert.equal(classifyStatus(502, ''), 'transient')
  assert.equal(classifyStatus(403, 'API rate limit exceeded'), 'transient')
  assert.equal(classifyStatus(403, 'Resource not accessible by integration'), 'fatal')
  assert.equal(classifyStatus(422, ''), 'fatal')
})

test('client throws TransientError vs FatalError per classification', async () => {
  const a = stubFetch([{ ok: false, status: 429, text: async () => 'slow down' }])
  await assert.rejects(createGitHub({ token: 't', fetchImpl: a.impl }).listOpenPrs('o/r'), TransientError)
  const b = stubFetch([{ ok: false, status: 422, text: async () => 'unprocessable' }])
  await assert.rejects(createGitHub({ token: 't', fetchImpl: b.impl }).listOpenPrs('o/r'), FatalError)
})

test('listOpenPrs requests open PRs with labels inline, not the search API', async () => {
  const { impl, calls } = stubFetch([{ ok: true, status: 200, json: async () => [{ number: 1 }] }])
  await createGitHub({ token: 't', fetchImpl: impl }).listOpenPrs('o/r')
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/pulls?state=open&per_page=100')
  assert.doesNotMatch(calls[0].url, /search/)
})

test('createReview posts the event and body', async () => {
  const { impl, calls } = stubFetch([{ ok: true, status: 200, json: async () => ({ html_url: 'u' }) }])
  await createGitHub({ token: 't', fetchImpl: impl }).createReview('o/r', 7, { event: 'APPROVE', body: 'lgtm' })
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/pulls/7/reviews')
  assert.deepEqual(calls[0].body, { event: 'APPROVE', body: 'lgtm' })
})

test('removeLabel tolerates a 404 — the label may already be gone', async () => {
  const { impl } = stubFetch([{ ok: false, status: 404, text: async () => 'Label does not exist' }])
  await assert.doesNotReject(createGitHub({ token: 't', fetchImpl: impl }).removeLabel('o/r', 7, 'review-requested'))
})

test('ensureLabel is a no-op when the label already exists', async () => {
  const { impl, calls } = stubFetch([{ ok: true, status: 200, json: async () => ({ name: 'review-error' }) }])
  await createGitHub({ token: 't', fetchImpl: impl }).ensureLabel('o/r', 'review-error', 'b60205', 'd')
  assert.equal(calls.length, 1, 'must not POST when GET succeeds')
})
