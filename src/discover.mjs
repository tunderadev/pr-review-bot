export function normalizePr(pr) {
  return {
    repo: pr.base.repo.full_name,
    number: pr.number,
    title: pr.title,
    author: pr.user.login,
    headSha: pr.head.sha,
    url: pr.html_url,
    draft: Boolean(pr.draft),
    updatedAt: pr.updated_at,
  }
}

// Drafts are intentionally included: the label is the explicit opt-in signal.
export function selectPrs(rawPrs, config) {
  const prefix = new RegExp(config.titlePrefix)
  return rawPrs
    .filter((pr) => pr.state === 'open' && !pr.merged_at)
    .filter((pr) => (pr.labels || []).some((l) => l.name === config.labels.requested))
    .filter((pr) => prefix.test(pr.title))
    .map(normalizePr)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(0, config.maxPerCycle)
}
