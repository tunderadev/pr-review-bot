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

// "Did not decode" is two different facts and they carry opposite weight.
//
// NOT_A_CANDIDATE: a markdown-quoted copy of a real block. Quoting a sticky
// comment has to stay free — it is what a human does when asking about a
// review — so these are ignored entirely.
//
// SUSPECT: anything else that fails to yield a valid state, whether it is
// base64 that decodes to nothing valid or a payload outside the alphabet
// entirely. Either the bot's own block is damaged or someone wrote a block of
// their own. Nothing else in the body can be trusted to be the bot's memory
// after that, so a SUSPECT block poisons the whole parse rather than being
// skipped over.
const NOT_A_CANDIDATE = Symbol('not-a-candidate')
const SUSPECT = Symbol('suspect')

// Leaving the alphabet is not by itself evidence of quoting, and reading it
// that way was a hole big enough to drive the whole attack through: ONE
// character outside [A-Za-z0-9+/=\s] anywhere in the real payload made the
// bot's own block invisible, leaving an appended forgery as the only decodable
// block in the body — unambiguous, and adopted. A zero-width space does it
// while leaving the comment visually identical to the untouched one. The same
// corruption done with an in-alphabet character has always returned null, so
// only one of those two answers can be right.
//
// A quote, unlike damage, announces itself: markdown quoting prefixes EVERY
// line, at any nesting depth and with or without the space after ">". So
// quoting is recognised positively, and a segment carrying no quoted line at
// all — including an emptied payload — is doubted rather than ignored.
function looksQuoted(segment) {
  const lines = segment.split('\n').filter((line) => line.trim())
  return lines.length > 0 && lines.every((line) => /^\s*>/.test(line))
}

function classifyBlock(segment) {
  const payload = segment.trim()
  if (!payload || !BASE64_ONLY.test(payload)) return looksQuoted(segment) ? NOT_A_CANDIDATE : SUSPECT
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    // Unknown versions are healed by rebuilding rather than guessed at.
    return isValidState(parsed) ? { state: parsed } : SUSPECT
  } catch {
    return SUSPECT
  }
}

export function parseState(body) {
  if (typeof body !== 'string') return null
  // Position is not a trust signal. The sticky comment is editable by anyone
  // with write access, so a second block can be placed above or below the
  // bot's own — indented, fenced, or raw, all of which still decode because
  // \s is inside the base64 alphabet. Four parsers each picked a position
  // (first, last, newest-first, oldest-first) and each only moved the hole to
  // the other end of the body. So this one does not choose: it reads the whole
  // body and answers only when the answer is unambiguous. One decodable block
  // and no damaged ones is the only arrangement the bot itself ever writes;
  // anything else returns null and the caller heals from emptyState(), which
  // costs a re-announce and is undone by the head-SHA check, where adopting a
  // forged Slack binding is not undone by anything.
  //
  // split() rather than an index scan: a scan whose advance stops being
  // monotonic HANGS the process, and a hang is the one failure this suite
  // cannot report. Iterating a fixed array cannot loop forever however it is
  // later edited. Every segment after the first begins just past a marker.
  let found = null
  for (const segment of body.split(MARKER).slice(1)) {
    const end = segment.indexOf(END)
    // An unterminated marker is a block whose end was LOST, not a block that
    // was never there. GitHub truncates long comment bodies, and the block that
    // gets cut is always the bot's own — it is written last, at the bottom — so
    // skipping it silently promoted an older copy pasted above into the only
    // complete block in the body, rolling the ledger back. Doubting it costs a
    // re-announce; skipping it cost the ledger.
    if (end === -1) return null
    const block = classifyBlock(segment.slice(0, end))
    if (block === NOT_A_CANDIDATE) continue
    if (block === SUSPECT || found) return null
    found = block.state
  }
  return found
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
