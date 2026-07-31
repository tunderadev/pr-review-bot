export class TransientError extends Error {}
export class FatalError extends Error {}

export function classifyStatus(status, bodyText = '') {
  if (status === 429 || status >= 500) return 'transient'
  if (status === 403 && /rate limit|secondary rate|abuse detection/i.test(bodyText)) return 'transient'
  return 'fatal'
}

export function createGitHub({ token, fetchImpl = fetch, baseUrl = 'https://api.github.com' }) {
  async function api(path, { method = 'GET', body, tolerate404 = false } = {}) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (res.ok) return res.json()
    if (res.status === 404 && tolerate404) return null
    const text = await res.text()
    const message = `GitHub ${method} ${path} failed (${res.status}): ${text}`
    throw classifyStatus(res.status, text) === 'transient' ? new TransientError(message) : new FatalError(message)
  }

  return {
    // Live data with labels inline. The search API is avoided: its index lags,
    // which would randomly delay label pickup.
    listOpenPrs: (repo) => api(`/repos/${repo}/pulls?state=open&per_page=100`),
    listReviews: (repo, number) => api(`/repos/${repo}/pulls/${number}/reviews?per_page=100`),
    listPrFiles: (repo, number) => api(`/repos/${repo}/pulls/${number}/files?per_page=100`),
    listIssueComments: (repo, number) => api(`/repos/${repo}/issues/${number}/comments?per_page=100`),
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
