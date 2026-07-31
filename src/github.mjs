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
export function nextPageUrl(linkHeader) {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    if (!/;\s*rel="?next"?/.test(part)) continue
    const match = part.match(/<([^>]+)>/)
    if (match) return match[1]
  }
  return null
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
      // sticky review-error label that is never auto-retried.
      const code = err?.cause?.code
      throw new TransientError(`GitHub ${method} ${label} transport failure: ${err?.message ?? err}${code ? ` (${code})` : ''}`, { cause: err })
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

  // Silent truncation is the worst outcome here: a ledger comment past page 1
  // reads as "never reviewed", so the bot re-announces and re-reviews forever.
  async function apiPaged(path) {
    const items = []
    let url = `${baseUrl}${path}`
    for (let fetched = 0; fetched < MAX_PAGES; fetched++) {
      const { data, res } = await request(url, { label: path })
      items.push(...(data ?? []))
      const next = nextPageUrl(res.headers?.get?.('link'))
      if (!next) return items
      url = next
    }
    throw new FatalError(`GitHub GET ${path} still had a next page after ${MAX_PAGES} pages; refusing to return a truncated list`)
  }

  return {
    // Live data with labels inline. The search API is avoided: its index lags,
    // which would randomly delay label pickup.
    listOpenPrs: (repo) => apiPaged(`/repos/${repo}/pulls?state=open&per_page=100`),
    listReviews: (repo, number) => apiPaged(`/repos/${repo}/pulls/${number}/reviews?per_page=100`),
    listPrFiles: (repo, number) => apiPaged(`/repos/${repo}/pulls/${number}/files?per_page=100`),
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
