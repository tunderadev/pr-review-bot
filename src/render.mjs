import { createHash } from 'node:crypto'

// Everything this module returns is published: into a PR review body the whole
// repo can read, or into a team Slack channel. Nothing local may reach either —
// no filesystem path, no environment value, no raw internal error string. The
// inputs are model-authored prose and GitHub-supplied fields, and those are
// exactly the two things that must be neutralised on the way out.

// The irreversible step. `blockers` is the SURVIVING blocker list, and a falsy
// length here becomes an APPROVE on the GitHub API. refuteBlockers returns
// `{survivors, refuted, runs, degraded}`, so passing the whole object instead of
// `.survivors` is one keystroke away and reads as length `undefined` — an
// approval on a PR whose every blocker survived verification, which is the worst
// thing this system can post. No shape this cannot count may resolve to APPROVE.
function surviving(blockers) {
  if (!Array.isArray(blockers)) throw new TypeError(`surviving blockers must be an array, got ${typeof blockers}`)
  return blockers.length
}

export const verdictToEvent = (blockers) => (surviving(blockers) ? 'REQUEST_CHANGES' : 'APPROVE')
export const verdictName = (blockers) => (surviving(blockers) ? 'changes_requested' : 'approved')

// Content only — no clock, no randomness, no machine identity. This value is
// stored in the sticky comment and compared across runs and across machines; a
// version that moved on its own would read as a criteria change on every cycle.
export function criteriaVersionOf(criteriaText) {
  return `sha256:${createHash('sha256').update(criteriaText).digest('hex').slice(0, 12)}`
}

// Model prose is untrusted markdown. Two things it must not be able to do in a
// review body: forge the document's own structure — a nit under a heading it
// wrote itself reads as a blocking defect — and HIDE it, since a single `<!--`
// comments out every section beneath it, so a body headed "Changes requested"
// can render with no blockers visible at all.
function safe(text) {
  return String(text ?? '')
    // Onto one line. Block-level markdown only fires at a line start, so
    // removing the line starts removes headings, rules, fences and list items
    // in a single move, and leaves the rest inert mid-line punctuation.
    .replace(/\s+/g, ' ')
    .trim()
    // No raw HTML, and in particular no comment opener. GitHub renders the
    // entity, so the reader still sees what the model actually wrote.
    .replace(/</g, '&lt;')
}

// The summary is the one model string not nested inside a list item, so its
// first character sits at a line start and can still open a block. Escaping
// that character is enough now that the value is a single line. ASCII
// punctuation only: `\#` renders as `#`, but `\3` renders as a literal `\3`.
const openLine = (text) => safe(text).replace(/^([#>\-+*=|~`_])/, '\\$1')

// parseVerdict validates `file` and `claim` as strings and never `line`, so a
// missing line reaches here; "src/a.ts:undefined" is not a location.
const locate = (f) => (Number.isInteger(f.line) ? `${f.file}:${f.line}` : String(f.file ?? ''))

const findingLine = (f) =>
  [
    `- **${safe(locate(f))}** — ${safe(f.claim)}`,
    f.why ? `  - ${safe(f.why)}` : null,
    // The confirmation is the refutation pass's own sentence explaining why the
    // claim survived an attempt to knock it down; it is what makes a blocking
    // review arguable rather than an assertion.
    f.confirmation ? `  - _Verified: ${safe(f.confirmation)}_` : null,
  ]
    .filter(Boolean)
    .join('\n')

export function renderReviewBody({ round, summary, blockers, nits = [], resolved = [], skippedFiles = [], unverified = [], criteriaVersion }) {
  // `blockers` deliberately has no default. The other lists are presentational
  // and an absent one is harmless, but an absent blocker list must not read as
  // "nothing blocking" — surviving() throws instead.
  const parts = [`## ${surviving(blockers) ? '🔧 Changes requested' : '✅ Approved'} — Round ${round}`, '', openLine(summary), '']
  if (blockers.length) {
    parts.push(`### Blocking (${blockers.length})`, '', blockers.map(findingLine).join('\n'), '')
  }
  if (nits.length) {
    parts.push(`### Non-blocking notes (${nits.length})`, '', nits.map(findingLine).join('\n'), '')
  }
  // Only when something genuinely went unchecked. A blocker dropped with
  // unverified:true was never judged — the refutation timed out, errored, or
  // never honoured its contract — so zero survivors looks identical to a clean
  // review, and that difference is the whole basis for trusting the approval.
  // On the normal path this list is empty and the section does not exist:
  // nobody should have to read past a "none to report" box on every clean
  // review to reach the part that matters.
  if (unverified.length) {
    parts.push(
      `### Not verified (${unverified.length})`,
      '',
      'These were raised by the review and then dropped **without being judged** — the verification pass could not reach a verdict on them. They are **not blocking** and may well be wrong; they are listed because a review that could not check them is weaker than one that did.',
      '',
      // f.refutation is this tool's own fixed sentence, written by refuteBlockers
      // to be publishable: it names the failure mode and deliberately carries no
      // worktree path, elapsed time or raw error text.
      unverified.map((f) => `- **${safe(locate(f))}** — ${safe(f.claim)}${f.refutation ? ` _(${safe(f.refutation)})_` : ''}`).join('\n'),
      ''
    )
  }
  if (resolved.length) {
    parts.push('### Previously raised', '', resolved.map((r) => `- ${r.resolved ? '✅' : '⬜️'} ${safe(r.claim)}${r.how ? ` — ${safe(r.how)}` : ''}`).join('\n'), '')
  }
  if (skippedFiles.length) {
    parts.push(
      '### Excluded from this review',
      '',
      'These files were too large to include and were **not reviewed**:',
      '',
      skippedFiles.map((f) => `- \`${safe(f)}\``).join('\n'),
      ''
    )
  }
  parts.push('---', `<sub>Automated review · criteria \`${safe(criteriaVersion)}\` · re-add the review-requested label after pushing fixes.</sub>`)
  return parts.join('\n')
}

// Slack's control characters, escaped exactly as Slack documents. `<!channel>`
// in a claim or a PR title notifies everyone in the channel, and both strings
// are attacker-influenced — the title is the author's own text, a claim is model
// prose about the author's diff. `&` must go first or the escapes escape.
const slackSafe = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// The URL has to stay a live link, so it cannot be entity-escaped; instead the
// three characters that would end the link or split its label are dropped.
const slackLink = (url, label) => `<${String(url ?? '').replace(/[<>|]/g, '')}|${slackSafe(label)}>`

export function renderAnnouncement({ pr, summary }) {
  return [`*Review requested* — ${slackLink(pr.url, `${pr.repo}#${pr.number}`)}`, `*${slackSafe(pr.title)}*`, `Author: \`${slackSafe(pr.author)}\``, '', slackSafe(summary)].join('\n')
}

export function renderChangesRequested({ mentionText, round, blockers, pr }) {
  const count = surviving(blockers)
  return [
    // mentionText is this tool's own output — a real <@U…> from resolveMention,
    // or a plain `@login` when the author could not be mapped. It is the one
    // string here that must NOT be escaped, or the author is never notified.
    `${mentionText} changes requested on round ${round} — ${count} blocking ${count === 1 ? 'item' : 'items'}:`,
    blockers.map((b) => `• \`${slackSafe(locate(b))}\` ${slackSafe(b.claim)}`).join('\n'),
    '',
    `${slackLink(pr.url, 'Read the full review')} · push fixes, then add the \`review-requested\` label again.`,
  ].join('\n')
}

export function renderNoNewCommits({ round }) {
  return `No new commits since round ${round} — nothing to re-review. Push changes, then add the label again.`
}
