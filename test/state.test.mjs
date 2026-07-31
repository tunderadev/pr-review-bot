import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { parseState, renderStateComment, findSticky, appendRound, alreadyReviewedSha, emptyState, lastRound, STATE_VERSION } from '../src/state.mjs'

const state = {
  version: STATE_VERSION,
  slack: { channel: 'C1', ts: '1712345678.123456', stateEmoji: 'x' },
  criteriaVersion: 'sha256:ab12',
  rounds: [{ round: 1, sha: 'abc1234', verdict: 'changes_requested', at: '2026-07-29T18:00:00Z', blockers: [{ file: 'src/a.ts', line: 42, claim: 'unhandled null' }] }],
}

test('render then parse round-trips exactly', () => {
  assert.deepEqual(parseState(renderStateComment(state)), state)
})

test('rendered comment is human-readable above the hidden block', () => {
  const body = renderStateComment(state)
  assert.match(body, /Claude review ledger/)
  assert.match(body, /changes requested/i)
  assert.match(body, /<!-- pr-review-bot:state/)
})

test('parseState returns null for absent, unmarked, malformed, or future-version bodies', () => {
  assert.equal(parseState(undefined), null)
  assert.equal(parseState('just a comment'), null)
  assert.equal(parseState('<!-- pr-review-bot:state\n{not json\n-->'), null)
  assert.equal(parseState('<!-- pr-review-bot:state\n{"version":99}\n-->'), null)
})

test('findSticky matches only the bot comment carrying the marker', () => {
  const comments = [
    { id: 1, user: { login: 'octocat' }, body: renderStateComment(state) },
    { id: 2, user: { login: 'plat-reviewer[bot]' }, body: 'nice work' },
    { id: 3, user: { login: 'plat-reviewer[bot]' }, body: renderStateComment(state) },
  ]
  assert.equal(findSticky(comments, 'plat-reviewer[bot]').id, 3)
  assert.equal(findSticky([], 'plat-reviewer[bot]'), null)
})

test('appendRound increments and does not mutate the input', () => {
  const next = appendRound(state, { sha: 'def5678', verdict: 'approved', at: '2026-07-29T19:00:00Z', blockers: [] })
  assert.equal(next.rounds.length, 2)
  assert.equal(next.rounds[1].round, 2)
  assert.equal(state.rounds.length, 1)
  assert.equal(lastRound(next).verdict, 'approved')
})

test('emptyState has no slack binding and no rounds', () => {
  assert.deepEqual(emptyState(), { version: STATE_VERSION, slack: null, criteriaVersion: null, rounds: [] })
  assert.equal(lastRound(emptyState()), null)
})

test('alreadyReviewedSha matches bot reviews at that exact head SHA', () => {
  const reviews = [
    { user: { login: 'plat-reviewer[bot]' }, commit_id: 'abc1234', state: 'CHANGES_REQUESTED' },
    { user: { login: 'someone' }, commit_id: 'def5678', state: 'APPROVED' },
    { user: { login: 'plat-reviewer[bot]' }, commit_id: 'ghi9999', state: 'PENDING' },
  ]
  assert.equal(alreadyReviewedSha(reviews, 'plat-reviewer[bot]', 'abc1234'), true)
  assert.equal(alreadyReviewedSha(reviews, 'plat-reviewer[bot]', 'def5678'), false)
  assert.equal(alreadyReviewedSha(reviews, 'plat-reviewer[bot]', 'ghi9999'), false, 'PENDING is not a submitted review')
})

test('parseState survives blocker claims containing the end marker -->', () => {
  const stateWithArrow = {
    version: STATE_VERSION,
    slack: { channel: 'C1', ts: '1712345678.123456', stateEmoji: 'x' },
    criteriaVersion: 'sha256:ab12',
    rounds: [{ round: 1, sha: 'abc1234', verdict: 'changes_requested', at: '2026-07-29T18:00:00Z', blockers: [{ file: 'src/guard.ts', line: 15, claim: 'guard is if (x) --> return null unexpectedly' }] }],
  }
  assert.deepEqual(parseState(renderStateComment(stateWithArrow)), stateWithArrow)
})

// A markdown quote of a comment this tool actually rendered — base64 payload
// and all. Node's base64 decoder silently discards the "> " prefixes, so a
// quoted block decodes cleanly and is caught only by the BASE64_ONLY guard.
const quote = (text) => text.split('\n').map((line) => `> ${line}`).join('\n')

const OTHER_STATE = {
  version: STATE_VERSION,
  slack: { channel: 'C-OTHER', ts: '1600000000.000000', stateEmoji: 'eyes' },
  criteriaVersion: 'sha256:ffff',
  rounds: [{ round: 1, sha: 'def5678', verdict: 'approved', at: '2026-07-29T19:00:00Z', blockers: [] }],
}

test('parseState ignores a quoted post-base64 block preceding the real one', () => {
  const stateForBlock = {
    version: STATE_VERSION,
    slack: null,
    criteriaVersion: null,
    rounds: [{ round: 1, sha: 'def5678', verdict: 'approved', at: '2026-07-29T19:00:00Z', blockers: [] }],
  }
  const body = `> Previous review:\n${quote(renderStateComment(OTHER_STATE))}\n\n${renderStateComment(stateForBlock)}`
  assert.deepEqual(parseState(body), stateForBlock)
})

const QUOTED_BLOCK = `> Previous review:\n${quote(renderStateComment(OTHER_STATE))}`

function stateWithClaim(claim) {
  return {
    version: STATE_VERSION,
    slack: { channel: 'C1', ts: '1712345678.123456', stateEmoji: 'x' },
    criteriaVersion: 'sha256:ab12',
    rounds: [{ round: 1, sha: 'abc1234', verdict: 'changes_requested', at: '2026-07-29T18:00:00Z', blockers: [{ file: 'src/a.ts', line: 42, claim }] }],
  }
}

test('parseState survives a blocker claim containing the start marker itself', () => {
  // The claim is LLM prose about code the PR author controls, so it can contain
  // anything — including this tool's own opening delimiter.
  const hostile = stateWithClaim('template literal emits <!-- pr-review-bot:state into the page')
  assert.deepEqual(parseState(renderStateComment(hostile)), hostile)
})

test('parseState survives text appended after the hidden block', () => {
  const body = `${renderStateComment(state)}\n\n<!-- a human edited this sticky comment -->\nPlease also check the migration.`
  assert.deepEqual(parseState(body), state)
})

test('parseState ignores a quoted marker appended after the real block', () => {
  const body = `${renderStateComment(state)}\n\n${QUOTED_BLOCK}`
  assert.deepEqual(parseState(body), state)
})

test('the hidden block payload cannot contain a comment delimiter', () => {
  const hostile = stateWithClaim('guard is if (x) --> return null; see <!-- pr-review-bot:state -->')
  const body = renderStateComment(hostile)
  const start = body.indexOf('<!-- pr-review-bot:state') + '<!-- pr-review-bot:state'.length
  const payload = body.slice(start, body.indexOf('-->', start)).trim()
  assert.match(payload, /^[A-Za-z0-9+/=]+$/, 'payload must be base64 — structurally unable to hold a delimiter')
})

test('parseState returns null for an unknown version inside a well-formed block', () => {
  const encoded = Buffer.from(JSON.stringify({ version: 99, rounds: [] })).toString('base64')
  assert.equal(parseState(`<!-- pr-review-bot:state\n${encoded}\n-->`), null)
})

const block = (payloadObject) =>
  `<!-- pr-review-bot:state\n${Buffer.from(JSON.stringify(payloadObject)).toString('base64')}\n-->`

// Position is not a trust signal. The sticky comment is editable by anyone with
// write access, so a second block can be put ABOVE or BELOW the bot's own.
// Four parsers each picked a position — indexOf, lastIndexOf, newest-first,
// oldest-first — and each one only moved the hole to the other end of the body.
// When two blocks both decode there is no evidence which one the bot wrote, so
// the parser refuses to guess and the caller heals from emptyState().
const FORGED = {
  version: STATE_VERSION,
  slack: { channel: 'ATTACKER', ts: '1.1', stateEmoji: 'eyes' },
  criteriaVersion: null,
  rounds: [],
}

// Each of these is a paste a human could plausibly make — and each one still
// decodes, because \s is inside the base64 character class. Only "> " quoting
// escapes the alphabet, which is why quoting stays free and indenting does not.
const PASTE_STYLES = [
  ['raw', (text) => text],
  ['inside a ``` fence', (text) => `\`\`\`\n${text}\n\`\`\``],
  ['indented four spaces', (text) => text.split('\n').map((line) => `    ${line}`).join('\n')],
  ['tab-indented', (text) => text.split('\n').map((line) => `\t${line}`).join('\n')],
]

for (const [how, style] of PASTE_STYLES) {
  test(`a forged block ${how} ABOVE the real one wins nothing`, () => {
    const body = `${style(renderStateComment(FORGED))}\n\n${renderStateComment(state)}`
    assert.equal(parseState(body), null, 'two decodable blocks are ambiguous — heal from emptyState instead of picking one')
  })
}

test('a forged block appended BELOW the real one wins nothing', () => {
  // A forged Slack binding redirects every future update into a channel of the
  // attacker's choosing, so adopting it is strictly worse than forgetting.
  const body = `${renderStateComment(state)}\n\n${block(FORGED)}`
  assert.equal(parseState(body), null)
})

test('re-pasting an older sticky body, above or below, does not roll history back', () => {
  // Rolling back to round 1 makes the bot re-announce and re-review work it has
  // already reviewed, at the author's expense. Refusing both arrangements is
  // what makes the answer independent of where the copy landed.
  const older = { ...state, rounds: state.rounds.slice(0, 1) }
  const newer = appendRound(older, { sha: 'def5678', verdict: 'approved', at: '2026-07-29T20:00:00Z', blockers: [] })
  const reference = '\n\n---\nFor reference, the previous version of this comment:\n\n'
  assert.equal(parseState(`${renderStateComment(newer)}${reference}${renderStateComment(older)}`), null, 'older copy below')
  assert.equal(parseState(`${renderStateComment(older)}${reference}${renderStateComment(newer)}`), null, 'older copy above')
})

test('a corrupted real block returns null rather than falling back to another block', () => {
  // Healing from emptyState is recoverable; adopting someone else's state is not.
  // A block that is base64 but decodes to nothing valid is the bot's own memory
  // damaged or a forgery — either way the body has stopped being trustworthy,
  // so a second block that DOES decode must not inherit its authority.
  const real = renderStateComment(state)
  const corrupted = real.slice(0, real.length - 12) + '\n-->'
  assert.equal(parseState(`${QUOTED_BLOCK}\n\n${corrupted}`), null, 'quoted copy present')
  assert.equal(parseState(`${block(FORGED)}\n\n${corrupted}`), null, 'raw forged block above')
  assert.equal(parseState(`${corrupted}\n\n${block(FORGED)}`), null, 'raw forged block below')
})

// "Not base64" used to mean "not a candidate", which is exactly how a quoted
// copy looks — but it is also how the bot's OWN block looks after a single
// stray character lands in it. The damaged block then became invisible, and an
// appended forgery was the only decodable block left standing: unambiguous, and
// adopted. A quoted copy announces itself on every line; damage does not.
const MARKER = '<!-- pr-review-bot:state'

function insertIntoPayload(comment, char) {
  const start = comment.indexOf(MARKER) + MARKER.length
  const end = comment.indexOf('-->', start)
  const at = Math.floor((start + end) / 2)
  return comment.slice(0, at) + char + comment.slice(at)
}

const DAMAGE = [
  // U+200B renders as nothing at all: the sabotaged comment is byte-for-byte
  // visually identical to the real one, and \s does not cover it in JS, so the
  // alphabet gate rejected the real block while the reader saw nothing wrong.
  ['a zero-width space', '\u200b'],
  ['a hyphen', '-'],
]

for (const [what, char] of DAMAGE) {
  test(`${what} in the real payload does not hand the answer to an appended block`, () => {
    const body = `${insertIntoPayload(renderStateComment(state), char)}\n\n${block(FORGED)}`
    assert.equal(parseState(body), null, 'a damaged real block must poison the parse, not disappear from it')
  })
}

test('an in-alphabet edit and an out-of-alphabet edit are judged the same way', () => {
  // Same corruption, one character apart in the alphabet. Answering null for
  // one and the attacker's block for the other is the rule disagreeing with
  // itself, not two different situations.
  const inAlphabet = insertIntoPayload(renderStateComment(state), 'A')
  assert.equal(parseState(`${inAlphabet}\n\n${block(FORGED)}`), null)
})

test('a truncated body that loses the real block\'s end marker does not restore a stale one', () => {
  // GitHub truncates comment bodies. The block that gets cut is always the last
  // one — the bot's own, at the bottom — leaving an older copy pasted above as
  // the only complete block in the body. Adopting it rolls the ledger back and
  // re-reviews work the author already paid for.
  const stale = { ...state, rounds: [] }
  const body = `${block(stale)}\n\n${renderStateComment(state)}`
  const truncated = body.slice(0, body.length - 20)
  assert.ok(!truncated.endsWith('-->'), 'the truncation must actually remove the end marker')
  assert.equal(parseState(truncated), null, 'an unterminated marker is a block in doubt, not a block absent')
})

test('an unterminated marker beside the real block costs the real block', () => {
  // The accepted cost of doubting an unterminated marker, pinned so the choice
  // cannot be flipped back unnoticed: a marker with no "-->" pasted beside the
  // bot's own block takes the answer to null rather than leaving the real block
  // standing. null costs a re-announce that the head-SHA check undoes; the
  // alternative reads a truncated body as a stale ledger, which nothing undoes.
  const body = `${MARKER}\nnot finished\n\n${renderStateComment(state)}`
  assert.equal(parseState(body), null)
})

// Every quoting style GitHub's own "Quote reply" and hand-typed quotes produce.
// Quoting a sticky comment has to stay free: it is what a human does when
// asking about a review, and it must not cost the bot its memory.
const QUOTE_STYLES = [
  ['> ', (text) => text.split('\n').map((line) => `> ${line}`).join('\n')],
  ['>', (text) => text.split('\n').map((line) => `>${line}`).join('\n')],
  ['> > ', (text) => text.split('\n').map((line) => `> > ${line}`).join('\n')],
]

for (const [prefix, style] of QUOTE_STYLES) {
  test(`a "${prefix}"-quoted copy leaves the real block readable, above or below`, () => {
    const quoted = style(renderStateComment(OTHER_STATE))
    assert.deepEqual(parseState(`${quoted}\n\n${renderStateComment(state)}`), state, 'quoted above')
    assert.deepEqual(parseState(`${renderStateComment(state)}\n\n${quoted}`), state, 'quoted below')
  })
}

test('parseState returns null for a version-correct payload of the wrong shape', () => {
  // lastRound, appendRound and renderLedger all dereference these. A raw
  // TypeError is not a TransientError, so it applies the sticky review-error
  // label that is never auto-retried — over a comment the bot can just rebuild.
  const wrongShapes = [
    { version: STATE_VERSION },
    { version: STATE_VERSION, rounds: 'nope' },
    { version: STATE_VERSION, rounds: {} },
    { version: STATE_VERSION, rounds: [], slack: 'C0123ABC' },
    { version: STATE_VERSION, rounds: [], slack: [] },
    { version: STATE_VERSION, rounds: [null] },
    { version: STATE_VERSION, rounds: [{ round: 1, sha: 'abc1234', verdict: 'approved', at: 'now' }] },
    { version: STATE_VERSION, rounds: [{ round: 1, verdict: 'approved', at: 'now', blockers: [] }] },
  ]
  for (const payload of wrongShapes) {
    assert.equal(parseState(block(payload)), null, `accepted ${JSON.stringify(payload)}`)
  }
  assert.equal(parseState(2), null, 'a non-string body is not a comment')
  assert.equal(parseState('<!-- pr-review-bot:state\n\n-->'), null, 'an empty payload is not state')
  assert.equal(parseState(`<!-- pr-review-bot:state\n${Buffer.from('{"version":1,"rounds":[]').toString('base64')}\n-->`), null, 'truncated JSON')
})

test('a shape-valid payload still round-trips, including a state with no rounds', () => {
  assert.deepEqual(parseState(renderStateComment(emptyState())), emptyState())
  assert.deepEqual(parseState(renderStateComment(OTHER_STATE)), OTHER_STATE)
})

// A scan that advances non-monotonically does not fail this suite — it HANGS
// it, and a hang is the one failure the runner cannot report: an in-process
// timeout never fires because the synchronous loop owns the event loop. So the
// parse runs in a child process, where a timeout can actually kill it.
test('parseState terminates on a marker-dense body', () => {
  const stateModule = new URL('../src/state.mjs', import.meta.url).href
  const script = `
    const { parseState } = await import(${JSON.stringify(stateModule)})
    const marker = '<!-- pr-review-bot:state'
    parseState((marker + '\\nAAAA\\n-->\\n').repeat(500))
    parseState(marker.repeat(500))
    parseState(marker + '-->'.repeat(500))
    parseState(('a' + marker).repeat(500) + '-->')
  `
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(run.signal, null, `parseState did not terminate (killed by ${run.signal})`)
  assert.equal(run.status, 0, `child exited ${run.status}: ${run.stderr}`)
})
