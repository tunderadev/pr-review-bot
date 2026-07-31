export const STATE_VERSION = 1
const MARKER = '<!-- pr-review-bot:state'
const END = '-->'

export function emptyState() {
  return { version: STATE_VERSION, slack: null, criteriaVersion: null, rounds: [] }
}

export function lastRound(state) {
  return state.rounds.length ? state.rounds[state.rounds.length - 1] : null
}

const VERDICT_LABEL = { approved: 'approved', changes_requested: 'changes requested', error: 'errored' }

function renderLedger(state) {
  const rows = state.rounds
    .map((r) => `| ${r.round} | \`${r.sha.slice(0, 7)}\` | ${VERDICT_LABEL[r.verdict] || r.verdict} | ${r.blockers.length} | ${r.at} |`)
    .join('\n')
  return [
    '### Claude review ledger',
    '',
    '| Round | Commit | Verdict | Blockers | When |',
    '|---|---|---|---|---|',
    rows || '| — | — | no rounds yet | — | — |',
    '',
    '_Managed automatically. Re-add the review-requested label after pushing fixes._',
  ].join('\n')
}

// Base64 is the whole point: its alphabet excludes '<', '>' and '-', so the
// payload is structurally incapable of containing either delimiter. Blocker
// claims are LLM prose about code the PR author controls, so raw JSON here
// meant the payload could always forge the parser's own delimiters.
export function renderStateComment(state) {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64')
  return `${renderLedger(state)}\n\n${MARKER}\n${payload}\n${END}`
}

// Nothing a human quotes survives this: markdown quoting prefixes every line
// with "> ", and Node's base64 decoder silently discards those, so a quoted
// copy of a real block would otherwise decode cleanly and be indistinguishable
// from the block the bot wrote.
const BASE64_ONLY = /^[A-Za-z0-9+/=\s]+$/

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// Version alone is not enough. A version-correct payload of the wrong shape
// makes lastRound / appendRound / renderLedger throw a raw TypeError, and
// anything that is not a TransientError applies the sticky review-error label
// that is never auto-retried. Rejecting is safe: the caller heals from
// emptyState(). So validate exactly what those callers dereference.
function isValidState(parsed) {
  if (!isObject(parsed) || parsed.version !== STATE_VERSION) return false
  if (!Array.isArray(parsed.rounds)) return false
  // Loose equality on purpose: an absent slack binding reads the same as a
  // null one everywhere downstream, so it is not worth discarding history over.
  if (parsed.slack != null && !isObject(parsed.slack)) return false
  return parsed.rounds.every((r) => isObject(r) && typeof r.sha === 'string' && Array.isArray(r.blockers))
}

function decodeBlock(segment) {
  const payload = segment.trim()
  if (!payload || !BASE64_ONLY.test(payload)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    // Unknown versions are healed by rebuilding rather than guessed at.
    return isValidState(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function parseState(body) {
  if (typeof body !== 'string') return null
  // Markers can appear outside the real block on either side of it — a human
  // quoting an older sticky comment, or appending a note of their own. Scan
  // OLDEST-first: the bot writes its block last in the body it renders, so the
  // first block in an edited comment is the bot's own. Reading the newest
  // instead lets anything appended below win — a forged Slack binding, or a
  // re-pasted older copy that rolls the round history back and re-reviews.
  // A quoted copy appearing BEFORE the real block is rejected by BASE64_ONLY,
  // not by ordering.
  let start = body.indexOf(MARKER)
  while (start !== -1) {
    const end = body.indexOf(END, start + MARKER.length)
    if (end !== -1) {
      const state = decodeBlock(body.slice(start + MARKER.length, end))
      if (state) return state
    }
    start = body.indexOf(MARKER, start + MARKER.length)
  }
  return null
}

export function findSticky(comments, botLogin) {
  return comments.find((c) => c.user?.login === botLogin && (c.body || '').includes(MARKER)) || null
}

export function appendRound(state, round) {
  return { ...state, rounds: [...state.rounds, { round: state.rounds.length + 1, ...round }] }
}

export function alreadyReviewedSha(reviews, botLogin, sha) {
  return reviews.some((r) => r.user?.login === botLogin && r.commit_id === sha && r.state !== 'PENDING')
}
