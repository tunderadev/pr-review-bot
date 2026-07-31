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

export function renderStateComment(state) {
  return `${renderLedger(state)}\n\n${MARKER}\n${JSON.stringify(state)}\n${END}`
}

export function parseState(body) {
  if (!body || !body.includes(MARKER)) return null
  const start = body.indexOf(MARKER) + MARKER.length
  const end = body.indexOf(END, start)
  if (end === -1) return null
  try {
    const parsed = JSON.parse(body.slice(start, end).trim())
    // Unknown versions are healed by rebuilding rather than guessed at.
    if (parsed.version !== STATE_VERSION) return null
    return parsed
  } catch {
    return null
  }
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
