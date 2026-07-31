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

const BASE64_ONLY = /^[A-Za-z0-9+/=\s]+$/

function decodeBlock(segment) {
  const payload = segment.trim()
  if (!payload || !BASE64_ONLY.test(payload)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    // Unknown versions are healed by rebuilding rather than guessed at.
    if (!parsed || parsed.version !== STATE_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

export function parseState(body) {
  if (typeof body !== 'string') return null
  // Markers can appear outside the real block on either side of it — a human
  // quoting an older sticky comment, or appending a note of their own. Scan
  // occurrences newest-first and let a successful decode identify the block;
  // position alone cannot tell machine state from quoted prose.
  let start = body.lastIndexOf(MARKER)
  while (start !== -1) {
    const end = body.indexOf(END, start + MARKER.length)
    if (end !== -1) {
      const state = decodeBlock(body.slice(start + MARKER.length, end))
      if (state) return state
    }
    if (start === 0) break
    start = body.lastIndexOf(MARKER, start - 1)
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
