import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGitHub, classifyStatus, nextPageUrl, TransientError, FatalError } from '../src/github.mjs'

// Records headers too: without them, deleting the Authorization line from the
// client left the whole suite green.
function stubFetch(responses) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined })
    const { link, ...rest } = responses.shift() ?? { ok: true, status: 200, json: async () => ({}) }
    return {
      text: async () => '',
      json: async () => ({}),
      headers: { get: (name) => (name.toLowerCase() === 'link' ? link ?? null : null) },
      ...rest,
    }
  }
  return { impl, calls }
}

const header = (headers, name) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1]
const page = (items, link) => ({ ok: true, status: 200, json: async () => items, link })

// Every list endpoint, with the exact URL it must request first.
const LIST_ENDPOINTS = [
  ['listOpenPrs', (gh) => gh.listOpenPrs('o/r'), 'https://api.github.com/repos/o/r/pulls?state=open&per_page=100'],
  ['listReviews', (gh) => gh.listReviews('o/r', 7), 'https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100'],
  ['listPrFiles', (gh) => gh.listPrFiles('o/r', 7), 'https://api.github.com/repos/o/r/pulls/7/files?per_page=100'],
  ['listIssueComments', (gh) => gh.listIssueComments('o/r', 7), 'https://api.github.com/repos/o/r/issues/7/comments?per_page=100'],
]

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

test('every request carries the installation token and the pinned API version', async () => {
  const { impl, calls } = stubFetch([page([])])
  await createGitHub({ token: 'ghs_secret', fetchImpl: impl }).listOpenPrs('o/r')
  assert.equal(header(calls[0].headers, 'authorization'), 'Bearer ghs_secret')
  assert.equal(header(calls[0].headers, 'accept'), 'application/vnd.github+json')
  assert.equal(header(calls[0].headers, 'x-github-api-version'), '2022-11-28')
})

test('a write request declares a JSON content type', async () => {
  const { impl, calls } = stubFetch([{ ok: true, status: 201, json: async () => ({}) }])
  await createGitHub({ token: 't', fetchImpl: impl }).createIssueComment('o/r', 7, 'hi')
  assert.equal(header(calls[0].headers, 'content-type'), 'application/json')
  assert.equal(header(calls[0].headers, 'authorization'), 'Bearer t')
})

test('a dropped connection is transient, not a sticky never-retried review-error', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
  }
  await assert.rejects(createGitHub({ token: 't', fetchImpl }).listOpenPrs('o/r'), (e) => {
    assert.ok(e instanceof TransientError, `expected TransientError, got ${e.constructor.name}`)
    assert.match(e.message, /ECONNRESET/, 'the errno must survive for debugging')
    assert.match(e.message, /fetch failed/, 'the original message must survive')
    return true
  })
})

test('only known-retryable transport codes are transient', async () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']) {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed', { cause: { code } })
    }
    await assert.rejects(createGitHub({ token: 't', fetchImpl }).listOpenPrs('o/r'), (e) => {
      assert.ok(e instanceof TransientError, `${code}: expected TransientError, got ${e.constructor.name}`)
      return true
    })
  }
})

test('a transport failure no retry can clear is fatal, not an endless retry', async () => {
  // "Transient" means the runner restores the trigger label and tries again
  // next cycle. A misconfigured base URL, an expired certificate or a bug in a
  // wrapper is deterministic: retrying it forever surfaces nothing at all.
  const permanent = [
    ['bad base URL', new TypeError('Failed to parse URL from //api.github.com/repos/o/r/pulls'), /Failed to parse URL/],
    ['expired certificate', new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }), /CERT_HAS_EXPIRED/],
    ['buggy wrapper', new ReferenceError('fetchImpl is not defined'), /fetchImpl is not defined/],
    ['aborted request', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), /aborted/],
  ]
  for (const [what, err, messageRe] of permanent) {
    const fetchImpl = async () => {
      throw err
    }
    await assert.rejects(createGitHub({ token: 't', fetchImpl }).createReview('o/r', 7, { event: 'APPROVE', body: 'lgtm' }), (e) => {
      assert.ok(e instanceof FatalError, `${what}: expected FatalError, got ${e.constructor.name}`)
      assert.ok(!(e instanceof TransientError), `${what}: must not be retried forever`)
      assert.match(e.message, messageRe, `${what}: the original cause must survive`)
      return true
    })
  }
})

test('nextPageUrl parses a Link header whose URL contains a comma', async () => {
  // rel="next" is the only thing standing between a partial list and a bot
  // that reads a ledger comment on page 2 as "never reviewed".
  const url = 'https://api.github.com/repos/o/r/issues/7/comments?labels=a,b&page=2'
  assert.equal(nextPageUrl(`<${url}>; rel="next", <${url.replace('page=2', 'page=9')}>; rel="last"`, '/x'), url)
  assert.equal(nextPageUrl(`<${url}>; rel="prev", <${url}>; rel="last"`, '/x'), null, 'no rel="next" means the last page')
  assert.equal(nextPageUrl('', '/x'), null)
  assert.equal(nextPageUrl(undefined, '/x'), null)
})

test('an unparseable rel="next" is fatal rather than a silent last page', () => {
  assert.throws(() => nextPageUrl('rel="next"; <https://api.github.com/x?page=2>', '/repos/o/r/pulls'), (e) => {
    assert.ok(e instanceof FatalError, `expected FatalError, got ${e.constructor.name}`)
    assert.match(e.message, /\/repos\/o\/r\/pulls/, 'the error must name the endpoint')
    return true
  })
})

test('apiPaged follows a next link whose URL contains a comma', async () => {
  const first = 'https://api.github.com/repos/o/r/issues/7/comments?per_page=100'
  const second = `${first}&labels=a,b&page=2`
  const { impl, calls } = stubFetch([page([{ id: 1 }], `<${second}>; rel="next", <${second}>; rel="last"`), page([{ id: 2 }])])
  const items = await createGitHub({ token: 't', fetchImpl: impl }).listIssueComments('o/r', 7)
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }])
  assert.equal(calls[1].url, second)
})

test('apiPaged refuses to treat an unparseable next link as the last page', async () => {
  const { impl } = stubFetch([page([{ id: 1 }], 'rel="next"; <https://api.github.com/x?page=2>')])
  await assert.rejects(createGitHub({ token: 't', fetchImpl: impl }).listIssueComments('o/r', 7), (e) => {
    assert.ok(e instanceof FatalError, `expected FatalError, got ${e.constructor.name}`)
    assert.match(e.message, /\/repos\/o\/r\/issues\/7\/comments/, 'the error must name the endpoint')
    return true
  })
})

for (const [name, call, url] of LIST_ENDPOINTS) {
  test(`${name} requests exactly ${url}`, async () => {
    const { impl, calls } = stubFetch([page([])])
    await call(createGitHub({ token: 't', fetchImpl: impl }))
    assert.equal(calls[0].url, url)
    assert.doesNotMatch(calls[0].url, /search/, 'the search index lags and would delay label pickup')
  })

  test(`${name} follows Link rel="next" instead of silently returning page 1`, async () => {
    const nextUrl = `${url}&page=2`
    const { impl, calls } = stubFetch([
      page([{ id: 1 }], `<${nextUrl}>; rel="next", <${url}&page=9>; rel="last"`),
      page([{ id: 2 }]),
    ])
    const items = await call(createGitHub({ token: 't', fetchImpl: impl }))
    assert.deepEqual(items, [{ id: 1 }, { id: 2 }])
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, nextUrl)
    assert.equal(header(calls[1].headers, 'authorization'), 'Bearer t', 'page 2 must be authenticated too')
  })

  test(`${name} throws rather than truncating past the page cap`, async () => {
    const endless = Array.from({ length: 12 }, (_, i) => page([{ id: i }], `<${url}&page=${i + 2}>; rel="next"`))
    const { impl, calls } = stubFetch(endless)
    await assert.rejects(call(createGitHub({ token: 't', fetchImpl: impl })), (e) => {
      assert.ok(e instanceof FatalError, `expected FatalError, got ${e.constructor.name}`)
      assert.match(e.message, /page/i)
      return true
    })
    assert.equal(calls.length, 10, 'the cap is 10 pages')
  })
}

test('createReview posts the event and body', async () => {
  const { impl, calls } = stubFetch([{ ok: true, status: 200, json: async () => ({ html_url: 'u' }) }])
  await createGitHub({ token: 't', fetchImpl: impl }).createReview('o/r', 7, { event: 'APPROVE', body: 'lgtm' })
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/pulls/7/reviews')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].body, { event: 'APPROVE', body: 'lgtm' })
})

test('createIssueComment posts to the issue comments collection', async () => {
  const { impl, calls } = stubFetch([{ ok: true, status: 201, json: async () => ({ id: 5 }) }])
  await createGitHub({ token: 't', fetchImpl: impl }).createIssueComment('o/r', 7, 'sticky body')
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/issues/7/comments')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].body, { body: 'sticky body' })
})

test('updateIssueComment patches the repo-level comment resource, not a PR-scoped path', async () => {
  const { impl, calls } = stubFetch([{ ok: true, status: 200, json: async () => ({ id: 5 }) }])
  await createGitHub({ token: 't', fetchImpl: impl }).updateIssueComment('o/r', 5, 'updated body')
  // Comment IDs are repo-scoped: /issues/comments/{id}, never /issues/{n}/comments/{id}.
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/issues/comments/5')
  assert.equal(calls[0].method, 'PATCH')
  assert.deepEqual(calls[0].body, { body: 'updated body' })
})

test('addLabel posts the label onto the issue', async () => {
  const { impl, calls } = stubFetch([{ ok: true, status: 200, json: async () => [] }])
  await createGitHub({ token: 't', fetchImpl: impl }).addLabel('o/r', 7, 'review-in-progress')
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/issues/7/labels')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].body, { labels: ['review-in-progress'] })
})

test('removeLabel deletes the URL-encoded label and tolerates a 404 — it may already be gone', async () => {
  const { impl, calls } = stubFetch([{ ok: false, status: 404, text: async () => 'Label does not exist' }])
  await assert.doesNotReject(createGitHub({ token: 't', fetchImpl: impl }).removeLabel('o/r', 7, 'review requested'))
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/issues/7/labels/review%20requested')
  assert.equal(calls[0].method, 'DELETE')
})

test('ensureLabel is a no-op when the label already exists', async () => {
  const { impl, calls } = stubFetch([{ ok: true, status: 200, json: async () => ({ name: 'review-error' }) }])
  await createGitHub({ token: 't', fetchImpl: impl }).ensureLabel('o/r', 'review-error', 'b60205', 'd')
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/labels/review-error')
  assert.equal(calls.length, 1, 'must not POST when GET succeeds')
})

test('ensureLabel creates the label when the lookup 404s', async () => {
  const { impl, calls } = stubFetch([
    { ok: false, status: 404, text: async () => 'Not Found' },
    { ok: true, status: 201, json: async () => ({ name: 'review-error' }) },
  ])
  await createGitHub({ token: 't', fetchImpl: impl }).ensureLabel('o/r', 'review-error', 'b60205', 'sticky failure marker')
  assert.equal(calls[1].url, 'https://api.github.com/repos/o/r/labels')
  assert.equal(calls[1].method, 'POST')
  assert.deepEqual(calls[1].body, { name: 'review-error', color: 'b60205', description: 'sticky failure marker' })
})
