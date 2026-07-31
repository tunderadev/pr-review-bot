export class TransientError extends Error {}
export class FatalError extends Error {}

export function classifyStatus(status, bodyText = '') {
  if (status === 429 || status >= 500) return 'transient'
  if (status === 403 && /rate limit|secondary rate|abuse detection/i.test(bodyText)) return 'transient'
  return 'fatal'
}

// GitHub caps per_page at 100. Ten pages is far above any real PR while still
// bounding a runaway loop.
export const MAX_PAGES = 10

// Link: <https://…&page=2>; rel="next", <…>; rel="last"
//
// Splitting on "," severs a URL from its angle brackets the moment a query
// value contains one (?labels=a,b), and the caller reads the resulting null as
// "last page" — silent truncation, which is the one outcome pagination exists
// to prevent. Match <uri>; params pairs instead: the URI is delimited by the
// brackets, and only the params run stops at a comma.
const LINK_PAIR_RE = /<([^<>]*)>\s*;\s*([^,<>]*)/g
const REL_NEXT_RE = /\brel\s*=\s*"?next\b/i

export function nextPageUrl(linkHeader, label = '') {
  if (!linkHeader) return null
  for (const [, uri, params] of linkHeader.matchAll(LINK_PAIR_RE)) {
    if (REL_NEXT_RE.test(params)) return uri.trim()
  }
  // A rel="next" we could not parse means there IS another page. Returning
  // null here would drop it silently; stopping loudly is the lesser failure.
  // URI-references are stripped first so a "next" inside a URL cannot fire.
  if (REL_NEXT_RE.test(linkHeader.replace(/<[^<>]*>/g, ''))) {
    throw new FatalError(`GitHub GET ${label} returned a Link header with an unparseable rel="next": ${linkHeader}`)
  }
  return null
}

// A transport failure is only transient if trying again could plausibly work.
// TransientError makes the runner restore the trigger label and retry next
// cycle, so a deterministic fault classified transient — a misconfigured base
// URL, an expired certificate, a bug in a wrapper — retries forever and
// surfaces nothing. Everything outside this list stops loudly instead.
const RETRYABLE_TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'])
// undici's own failures are timeouts, resets and closed sockets — except these
// two, which report a bad argument and are as deterministic as a typo.
const DETERMINISTIC_UNDICI_CODES = new Set(['UND_ERR_INVALID_ARG', 'UND_ERR_NOT_SUPPORTED'])

export function isRetryableTransportCode(code) {
  if (typeof code !== 'string') return false
  if (DETERMINISTIC_UNDICI_CODES.has(code)) return false
  return RETRYABLE_TRANSPORT_CODES.has(code) || code.startsWith('UND_ERR_')
}

export function createGitHub({ token, fetchImpl = fetch, baseUrl = 'https://api.github.com' }) {
  async function request(url, { method = 'GET', body, tolerate404 = false, label = url } = {}) {
    let res
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch (err) {
      // A dropped connection throws from fetch itself, so it never reached
      // classifyStatus — and anything that is not a TransientError applies the
      // sticky review-error label that is never auto-retried. But catching
      // everything here was worse: it made a bad baseUrl, an expired
      // certificate and a ReferenceError in a wrapper all retry forever.
      // undici reports the errno on err.cause; some errors carry it directly.
      const code = err?.cause?.code ?? err?.code
      const message = `GitHub ${method} ${label} transport failure: ${err?.message ?? err}${code ? ` (${code})` : ''}`
      throw isRetryableTransportCode(code)
        ? new TransientError(message, { cause: err })
        : new FatalError(message, { cause: err })
    }
    if (res.ok) return { data: await res.json(), res }
    if (res.status === 404 && tolerate404) return { data: null, res }
    const text = await res.text()
    const message = `GitHub ${method} ${label} failed (${res.status}): ${text}`
    throw classifyStatus(res.status, text) === 'transient' ? new TransientError(message) : new FatalError(message)
  }

  async function api(path, options = {}) {
    const { data } = await request(`${baseUrl}${path}`, { ...options, label: path })
    return data
  }

  // Collects up to MAX_PAGES and says whether it stopped early. What to do
  // about that is the caller's decision, because it differs per endpoint.
  async function collectPages(path) {
    const items = []
    let url = `${baseUrl}${path}`
    for (let fetched = 0; fetched < MAX_PAGES; fetched++) {
      const { data, res } = await request(url, { label: path })
      // A 200 can still carry an object — {"message": …} on a redirect, or a
      // proxy's error envelope. Spreading it threw a raw TypeError: neither
      // TransientError nor FatalError, so it landed on the sticky
      // never-retried label naming neither the endpoint nor the cause.
      if (!Array.isArray(data)) {
        throw new FatalError(`GitHub GET ${path} returned ${data === null ? 'null' : typeof data} where a list was expected`)
      }
      items.push(...data)
      const next = nextPageUrl(res.headers?.get?.('link'), path)
      if (!next) return { items, truncated: false }
      url = next
    }
    return { items, truncated: true }
  }

  // Silent truncation is the worst outcome here: a ledger comment past page 1
  // reads as "never reviewed", so the bot re-announces and re-reviews forever.
  async function apiPaged(path) {
    const { items, truncated } = await collectPages(path)
    if (truncated) {
      throw new FatalError(`GitHub GET ${path} still had a next page after ${MAX_PAGES} pages; refusing to return a truncated list`)
    }
    return items
  }

  return {
    // Live data with labels inline. The search API is avoided: its index lags,
    // which would randomly delay label pickup.
    listOpenPrs: (repo) => apiPaged(`/repos/${repo}/pulls?state=open&per_page=100`),
    listReviews: (repo, number) => apiPaged(`/repos/${repo}/pulls/${number}/reviews?per_page=100`),
    // The odd one out: a legitimately large PR — a lockfile regen, a codemod, a
    // vendored directory — must not be benched by the sticky never-retried
    // label over a deterministic condition no retry can clear. The pipeline
    // already truncates diffs by design via maxDiffLines and names what it
    // skipped, so it reports truncation instead of throwing.
    async listPrFiles(repo, number) {
      const { items, truncated } = await collectPages(`/repos/${repo}/pulls/${number}/files?per_page=100`)
      return { files: items, truncated }
    },
    listIssueComments: (repo, number) => apiPaged(`/repos/${repo}/issues/${number}/comments?per_page=100`),
    createIssueComment: (repo, number, body) => api(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } }),
    updateIssueComment: (repo, commentId, body) => api(`/repos/${repo}/issues/comments/${commentId}`, { method: 'PATCH', body: { body } }),
    addLabel: (repo, number, name) => api(`/repos/${repo}/issues/${number}/labels`, { method: 'POST', body: { labels: [name] } }),
    removeLabel: (repo, number, name) =>
      api(`/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, { method: 'DELETE', tolerate404: true }),
    createReview: (repo, number, { event, body }) => api(`/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', body: { event, body } }),
    async ensureLabel(repo, name, color, description) {
      const existing = await api(`/repos/${repo}/labels/${encodeURIComponent(name)}`, { tolerate404: true })
      if (existing) return existing
      return api(`/repos/${repo}/labels`, { method: 'POST', body: { name, color, description } })
    },
  }
}
