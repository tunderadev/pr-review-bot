// The announcement message carries exactly ONE state emoji. A PR is reviewed
// once per round, so the previous emoji has to come off as the new one goes on
// — otherwise a PR that went ❌ then ✅ wears both and the channel shows two
// contradictory states on one message. Repeating a verdict must be a true
// no-op: Slack errors on re-adding a reaction that is already there.
// An errored review is a THIRD terminal state, not a review still running.
// state.mjs has recorded an "error" verdict since it was written; falling
// through to inReview left the PR wearing 👀 forever, indistinguishable in the
// channel from one being reviewed right now — and since the review-error label
// is sticky and never auto-retried, nothing was ever going to move it.
export function planReactionChange({ previous, verdict, emoji }) {
  const next =
    verdict === 'approved' ? emoji.approved
    : verdict === 'changes_requested' ? emoji.changesRequested
    : verdict === 'error' ? emoji.error
    : emoji.inReview
  return {
    remove: previous && previous !== next ? previous : null,
    add: previous === next ? null : next,
    next,
  }
}

// Never throws: an unmapped author degrades to unlinked text plus mapped:false,
// which the caller logs so the mapping can be added. The GitHub review is
// already posted by the time this runs, so a missing mention is cosmetic.
export async function resolveMention({ login, authorMap = {}, email, lookupEmail }) {
  // Own-string check, not truthiness: a GitHub login like `constructor` or
  // `toString` hits Object.prototype and would otherwise mention a function.
  const mapped = typeof authorMap?.[login] === 'string' ? authorMap[login] : null
  if (mapped) return { text: `<@${mapped}>`, mapped: true }
  if (email && lookupEmail) {
    try {
      const id = await lookupEmail(email)
      if (id) return { text: `<@${id}>`, mapped: true }
    } catch {
      // fall through to unlinked text
    }
  }
  return { text: `\`@${login}\``, mapped: false }
}
