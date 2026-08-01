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

const hasLabel = (pr, name) => Boolean(name) && (pr.labels || []).some((l) => l?.name === name)

// review-error is terminal by contract: the cycle applies it when a human has
// to look, and no automation ever removes it. Selecting a PR that wears it
// means failing on it again, re-applying the label, and doing that every cycle
// forever — and a human who clears the label gets it straight back on the next
// poll, which reads as the tool ignoring them. The documented recovery is to
// clear review-error and re-add review-requested, and that is exactly what this
// exclusion makes work.
const isBenched = (pr, config) => hasLabel(pr, config.labels?.error)

// A PR wearing BOTH labels is somebody asking for a re-review that is never
// coming. Wearing only review-error it is simply benched and nobody is waiting,
// so that is not news; this is, every cycle, until they clear it.
export function prsBlockedByError(rawPrs, config) {
  return rawPrs.filter((pr) => hasLabel(pr, config.labels?.requested) && isBenched(pr, config))
}

// Drafts are intentionally included: the label is the explicit opt-in signal.
export function selectPrs(rawPrs, config) {
  const prefix = new RegExp(config.titlePrefix)
  return rawPrs
    .filter((pr) => pr.state === 'open' && !pr.merged_at)
    .filter((pr) => hasLabel(pr, config.labels.requested))
    .filter((pr) => !isBenched(pr, config))
    .filter((pr) => prefix.test(pr.title))
    .map(normalizePr)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(0, config.maxPerCycle)
}
