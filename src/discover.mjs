// Every dereference here is optional, and none of it is defensive habit: this
// runs before any PR is claimed, across every configured repo, so ONE payload
// that does not match the happy shape used to take the whole cycle down with a
// TypeError — reported to the operator as a bug in the tool. A deleted GitHub
// account is the realistic one: it arrives as `user: null` on a PR that is
// otherwise perfectly reviewable.
export function normalizePr(pr) {
  return {
    // Structurally required — there is no repository to address and no commit
    // to check out without these two, which is why selectPrs drops them.
    repo: pr?.base?.repo?.full_name ?? null,
    headSha: pr?.head?.sha ?? null,
    number: pr?.number,
    title: pr?.title,
    // Cosmetic by comparison: it names the author in the prompt and decides who
    // gets pinged in Slack. A missing one is worth a review with no mention,
    // never a skipped review.
    author: pr?.user?.login ?? null,
    url: pr?.html_url,
    draft: Boolean(pr?.draft),
    updatedAt: pr?.updated_at,
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
    // Not silence for its own sake: there is genuinely nothing to review — no
    // repository to call the API against, no commit to check out — and the
    // alternative was throwing, which took every OTHER repo's PRs down with it.
    .filter((pr) => pr.repo && pr.headSha)
    // String(): a payload with no updated_at would otherwise throw here, in the
    // comparator, where it is hardest to see coming.
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
    .slice(0, config.maxPerCycle)
}
