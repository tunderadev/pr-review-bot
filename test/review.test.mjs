import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { buildReviewPrompt, parseVerdict, VerdictParseError, runClaude, isUsageLimit, runReview, ReviewTimeoutError, DEFAULT_REVIEW_TIMEOUT_MS, buildChildEnv, CHILD_ENV_ALLOWLIST } from '../src/review.mjs'

const PR = { repo: 'o/r', number: 7, title: '[PLAT] add widget', author: 'octocat', headSha: 'abc1234', url: 'u' }

function fakeSpawn(envelopes) {
  const seen = []
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter()
    let stdinText = ''
    child.stdin = new Writable({ write(c, e, cb) { stdinText += c; cb() }, final(cb) { cb() } })
    const envelope = envelopes.shift()
    child.stdout = Readable.from([typeof envelope === 'string' ? envelope : JSON.stringify(envelope)])
    child.stderr = Readable.from([])
    setImmediate(() => {
      seen.push({ cmd, args, cwd: opts?.cwd, env: opts?.env, prompt: stdinText })
      child.emit('close', envelope?.__exit ?? 0)
    })
    return child
  }
  return { impl, seen }
}

// A child that never closes: the wedged review the timeout exists to bound.
function hungSpawn() {
  const killed = []
  let spawns = 0
  const impl = () => {
    spawns += 1
    const child = new EventEmitter()
    child.stdin = new Writable({ write(c, e, cb) { cb() }, final(cb) { cb() } })
    child.stdout = Readable.from([])
    child.stderr = Readable.from([])
    child.kill = (signal) => { killed.push(signal); return true }
    return child
  }
  return { impl, killed, spawns: () => spawns }
}

const goodVerdict = {
  summary: 'Adds a widget.',
  findings: [
    { severity: 'blocking', file: 'src/a.ts', line: 42, claim: 'unhandled null', why: 'crashes on empty input' },
    { severity: 'nit', file: 'src/b.ts', line: 3, claim: 'stale comment', why: 'says v1' },
  ],
  previousBlockersResolved: [],
}

test('prompt carries criteria, PR identity, diff, and prior blockers', () => {
  const p = buildReviewPrompt({
    criteria: 'CRITERIA-MARKER',
    pr: PR,
    diff: 'DIFF-MARKER',
    previousBlockers: [{ file: 'src/a.ts', line: 42, claim: 'PRIOR-MARKER' }],
    skippedFiles: ['big.lock'],
  })
  for (const marker of ['CRITERIA-MARKER', 'DIFF-MARKER', 'PRIOR-MARKER', 'big.lock', '[PLAT] add widget']) {
    assert.ok(p.includes(marker), `prompt must include ${marker}`)
  }
  assert.match(p, /"severity"/, 'prompt must state the required JSON shape')
})

test('parseVerdict accepts bare and fenced JSON', () => {
  assert.deepEqual(parseVerdict(JSON.stringify(goodVerdict)), goodVerdict)
  assert.deepEqual(parseVerdict('Here:\n```json\n' + JSON.stringify(goodVerdict) + '\n```\n'), goodVerdict)
})

test('parseVerdict rejects prose, missing keys, and bad severities', () => {
  assert.throws(() => parseVerdict('Looks good to me!'), VerdictParseError)
  assert.throws(() => parseVerdict('{"summary":"x"}'), VerdictParseError)
  assert.throws(() => parseVerdict(JSON.stringify({ summary: 's', findings: [{ severity: 'maybe', file: 'f', line: 1, claim: 'c', why: 'w' }], previousBlockersResolved: [] })), VerdictParseError)
})

test('runClaude passes no --model, allows only read-only tools, sends prompt on stdin', async () => {
  const { impl, seen } = fakeSpawn([{ result: 'ok', is_error: false, total_cost_usd: 0.01, duration_ms: 5, usage: { input_tokens: 1, output_tokens: 2 }, modelUsage: { 'claude-opus-5': { canonicalModel: 'claude-opus-5' } } }])
  const out = await runClaude({ prompt: 'PROMPT-BODY', cwd: '/wt', spawnImpl: impl })
  assert.equal(out.result, 'ok')
  assert.equal(out.costUsd, 0.01)
  assert.equal(out.model, 'claude-opus-5')
  assert.equal(seen[0].cwd, '/wt')
  assert.equal(seen[0].prompt, 'PROMPT-BODY')
  assert.ok(!seen[0].args.includes('--model'), 'must never pin a model')
  assert.deepEqual(seen[0].args.slice(0, 4), ['-p', '--output-format', 'json', '--allowed-tools'])
  assert.match(seen[0].args.join(' '), /Read Grep Glob/)

  // The whole argv, not a substring: a pin appended at the end, spelled `-m`, or
  // fused as `--model=opus` all slip past an `includes('--model')` check.
  assert.equal(seen[0].cmd, 'claude')
  assert.deepEqual(seen[0].args, ['-p', '--output-format', 'json', '--allowed-tools', 'Read Grep Glob', '--strict-mcp-config'])
})

// ---------------------------------------------------------------------------
// The child's cwd is a worktree of the PR head — a tree the PR AUTHOR wrote.
// Claude Code reads project configuration from its working directory at session
// start, and hooks and MCP servers are not tools, so --allowed-tools gates
// neither. checkout.mjs strips that configuration out of the tree; these are
// the other two layers, which have to hold even if that one is bypassed.
// ---------------------------------------------------------------------------

const TOOL_ENV = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/Users/operator',
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  // Everything below is this tool's own and must not reach a child running
  // inside a stranger's code.
  SLACK_BOT_TOKEN: 'xoxb-' + '1111-2222-abcdefghijklmnop',
  GITHUB_APP_PRIVATE_KEY_PATH: '/Users/operator/.config/pr-review-bot/app.pem',
  GITHUB_APP_ID: '123456',
  GITHUB_APP_INSTALLATION_ID: '7890',
  PR_REVIEW_CONFIG_DIR: '/Users/operator/.config/pr-review-bot/default',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
  ANTHROPIC_API_KEY: 'sk-ant-api03-should-never-be-handed-down',
}

test('MCP configuration is never discovered from the tree under review', async () => {
  const { impl, seen } = fakeSpawn([{ subtype: 'success', is_error: false, result: 'ok', usage: {}, total_cost_usd: 0, duration_ms: 1 }])
  await runClaude({ prompt: 'p', cwd: '/wt', spawnImpl: impl, env: TOOL_ENV })
  // A .mcp.json in the PR runs mcpServers[].command. It is not a tool, so
  // --allowed-tools does not gate it.
  assert.ok(seen[0].args.includes('--strict-mcp-config'), `no --strict-mcp-config in ${JSON.stringify(seen[0].args)}`)
})

test('the child gets an allow-listed environment, not the bot\'s own', async () => {
  const { impl, seen } = fakeSpawn([{ subtype: 'success', is_error: false, result: 'ok', usage: {}, total_cost_usd: 0, duration_ms: 1 }])
  await runClaude({ prompt: 'p', cwd: '/wt', spawnImpl: impl, env: TOOL_ENV })
  const childEnv = seen[0].env

  assert.ok(childEnv, 'spawn must be given an explicit env, or the child inherits process.env entire')
  // Named, not merely "not everything": a hook or an MCP server in the PR reads
  // these straight out of its own environment.
  for (const secret of ['SLACK_BOT_TOKEN', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'AWS_SECRET_ACCESS_KEY', 'PR_REVIEW_CONFIG_DIR']) {
    assert.equal(childEnv[secret], undefined, `${secret} was handed to a child running inside a stranger's code`)
  }
  // And by value, so a rename of the variable cannot smuggle it through.
  const values = Object.values(childEnv).join('\n')
  for (const secret of [TOOL_ENV.SLACK_BOT_TOKEN, TOOL_ENV.GITHUB_APP_PRIVATE_KEY_PATH, TOOL_ENV.AWS_SECRET_ACCESS_KEY, TOOL_ENV.ANTHROPIC_API_KEY]) {
    assert.equal(values.includes(secret), false, `a secret value reached the child: ${secret}`)
  }
  // …and it must still be able to run and find its own credentials.
  assert.equal(childEnv.HOME, '/Users/operator', 'without HOME claude cannot find its own login')
  assert.ok(childEnv.PATH?.includes('/usr/bin'), 'without PATH there is no claude to spawn')
  assert.equal(childEnv.LANG, 'en_US.UTF-8')
})

test('ANTHROPIC_API_KEY is deliberately withheld, matching doctor\'s refusal', async () => {
  // doctor fails outright when it is set, because it silently redirects billing
  // from the operator's subscription to metered API usage. Passing it down would
  // let a stray export in one shell quietly bill the API for every review — and
  // it is a live credential handed to a child running inside a stranger's code.
  const { impl, seen } = fakeSpawn([{ subtype: 'success', is_error: false, result: 'ok', usage: {}, total_cost_usd: 0, duration_ms: 1 }])
  await runClaude({ prompt: 'p', cwd: '/wt', spawnImpl: impl, env: TOOL_ENV })
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
    assert.equal(seen[0].env[key], undefined, `${key} must not travel to the review child`)
    assert.equal(CHILD_ENV_ALLOWLIST.includes(key), false, `${key} must not be on the allow-list`)
  }
})

// Found by attacking the fix rather than trusting it. execvp treats a
// ZERO-LENGTH PATH entry — a trailing ":", a leading ":", or a literal "." — as
// "the current directory", and the child's current directory is the PR author's
// tree. An executable file named `claude` committed at the repo root is then
// what runs, with no hook, no MCP server, and no settings file involved. The
// three layers above do nothing about it; only a sanitized PATH does.
test('a PATH entry meaning "the current directory" cannot make the PR\'s own tree executable', () => {
  assert.equal(buildChildEnv({ PATH: '/usr/bin:/bin:', HOME: '/h' }).PATH, '/usr/bin:/bin')
  assert.equal(buildChildEnv({ PATH: ':/usr/bin', HOME: '/h' }).PATH, '/usr/bin')
  assert.equal(buildChildEnv({ PATH: '/usr/bin:.:/bin', HOME: '/h' }).PATH, '/usr/bin:/bin')
  assert.equal(buildChildEnv({ PATH: '/usr/bin::/bin', HOME: '/h' }).PATH, '/usr/bin:/bin')
  assert.equal(buildChildEnv({ PATH: 'relative/bin:/usr/bin', HOME: '/h' }).PATH, '/usr/bin')
  // An emptied PATH must be ABSENT, not empty: PATH="" is itself one
  // zero-length entry, so setting it would reinstate exactly what this removes.
  assert.equal('PATH' in buildChildEnv({ PATH: '.', HOME: '/h' }), false, 'an emptied PATH must be dropped, never set to ""')
  assert.equal('PATH' in buildChildEnv({ HOME: '/h' }), false)
})

test('buildChildEnv passes through only what is on the allow-list, and never a blank', () => {
  const built = buildChildEnv(TOOL_ENV)
  assert.deepEqual(Object.keys(built).sort(), ['HOME', 'LANG', 'PATH', 'TERM'])
  assert.deepEqual(buildChildEnv({}), {}, 'an empty environment yields an empty environment, not undefineds')
  // Absent keys are omitted rather than set to undefined: `{FOO: undefined}` in
  // a spawn env is passed to the child as the literal string "undefined".
  assert.equal('LC_ALL' in buildChildEnv({ HOME: '/h' }), false)
  assert.ok(CHILD_ENV_ALLOWLIST.includes('HOME') && CHILD_ENV_ALLOWLIST.includes('PATH'))
})

test('isUsageLimit detects quota exhaustion for the transient path', () => {
  assert.equal(isUsageLimit({ isError: true, result: 'Claude usage limit reached' }), true)
  assert.equal(isUsageLimit({ isError: true, result: 'rate limit exceeded' }), true)
  assert.equal(isUsageLimit({ exitCode: 1, result: '' }), false)
  assert.equal(isUsageLimit({ isError: false, result: 'fine' }), false)
})

test('runReview retries an unparseable verdict exactly once, then throws', async () => {
  const bad = { result: 'no json here', is_error: false, usage: {}, total_cost_usd: 0, duration_ms: 1 }
  const good = { result: JSON.stringify(goodVerdict), is_error: false, usage: {}, total_cost_usd: 0, duration_ms: 1 }

  const retried = fakeSpawn([bad, good])
  const ok = await runReview({ criteria: 'c', pr: PR, diff: 'd', cwd: '/wt', spawnImpl: retried.impl })
  assert.equal(ok.verdict.findings.length, 2)
  assert.equal(retried.seen.length, 2)
  assert.match(retried.seen[1].prompt, /JSON/i, 'retry restates the contract')

  const hopeless = fakeSpawn([bad, bad])
  await assert.rejects(runReview({ criteria: 'c', pr: PR, diff: 'd', cwd: '/wt', spawnImpl: hopeless.impl }), VerdictParseError)
})

// --- Additional coverage: each of these fails against a plausible wrong
// implementation that the brief's own assertions above would have accepted.

test('the retry prompt is the original plus a correction, not a rerun of the same words', async () => {
  const bad = { result: 'Looks good to me!', is_error: false, usage: {}, total_cost_usd: 0, duration_ms: 1 }
  const good = { result: JSON.stringify(goodVerdict), is_error: false, usage: {}, total_cost_usd: 0, duration_ms: 1 }
  const { impl, seen } = fakeSpawn([bad, good])

  await runReview({ criteria: 'c', pr: PR, diff: 'd', cwd: '/wt', spawnImpl: impl })

  // /JSON/i alone is satisfied by the unmodified first prompt, which already
  // states the contract — so it cannot tell a real retry from a replay.
  assert.notEqual(seen[1].prompt, seen[0].prompt, 'the retry must not resend the identical prompt')
  assert.ok(seen[1].prompt.startsWith(seen[0].prompt), 'the retry keeps the original prompt')
  assert.match(seen[1].prompt.slice(seen[0].prompt.length), /not valid JSON/i, 'the retry names the failure')
})

test('runReview retries once and then stops, rather than looping', async () => {
  const bad = { result: 'still prose', is_error: false, usage: {}, total_cost_usd: 0, duration_ms: 1 }
  const { impl, seen } = fakeSpawn([bad, bad, bad, bad])

  await assert.rejects(runReview({ criteria: 'c', pr: PR, diff: 'd', cwd: '/wt', spawnImpl: impl }), VerdictParseError)
  assert.equal(seen.length, 2, 'exactly two attempts: the original and one retry')
})

test('runReview never infers approval from prose: an unparseable verdict yields no verdict at all', async () => {
  const prose = { result: 'LGTM, ship it. No blocking issues.', is_error: false, usage: {}, total_cost_usd: 0, duration_ms: 1 }
  const { impl } = fakeSpawn([prose, prose])
  await assert.rejects(
    runReview({ criteria: 'c', pr: PR, diff: 'd', cwd: '/wt', spawnImpl: impl }),
    (e) => e instanceof VerdictParseError && !('verdict' in e),
  )
})

test('a quota exhaustion is not charged to the PR: no retry, and the run is recoverable for classification', async () => {
  const limited = {
    result: 'Claude AI usage limit reached|1730000000',
    is_error: true,
    subtype: 'error_during_execution',
    usage: {},
    total_cost_usd: 0,
    duration_ms: 1,
  }
  const { impl, seen } = fakeSpawn([limited, limited])

  const err = await runReview({ criteria: 'c', pr: PR, diff: 'd', cwd: '/wt', spawnImpl: impl }).then(
    () => null,
    (e) => e,
  )
  assert.ok(err instanceof VerdictParseError)
  assert.equal(seen.length, 1, 'a second call cannot beat a quota wall')
  assert.ok(err.run, 'the failing run travels with the error')
  assert.equal(isUsageLimit(err.run), true, 'the caller can take the transient path')
})

test('a retried review reports every run, so telemetry sees what the retry cost', async () => {
  const bad = { subtype: 'success', is_error: false, result: 'no json here', usage: { input_tokens: 100, output_tokens: 5 }, total_cost_usd: 0.02, duration_ms: 11 }
  const good = { subtype: 'success', is_error: false, result: JSON.stringify(goodVerdict), usage: { input_tokens: 120, output_tokens: 60 }, total_cost_usd: 0.03, duration_ms: 22 }
  const { impl } = fakeSpawn([bad, good])

  const out = await runReview({ criteria: 'c', pr: PR, diff: 'd', cwd: '/wt', spawnImpl: impl })

  // A retried review is the expensive kind. Reporting only the attempt that
  // happened to parse understates the cost of exactly those reviews.
  assert.equal(out.runs.length, 2, 'both attempts are reported')
  assert.deepEqual(out.runs.map((r) => r.costUsd), [0.02, 0.03], 'the discarded attempt still cost money')
  assert.deepEqual(out.runs.map((r) => r.durationMs), [11, 22])
  assert.deepEqual(out.runs.map((r) => r.usage.input_tokens), [100, 120])
  assert.equal(out.run, out.runs.at(-1), 'run stays available, as the last attempt')
})

test('a review that parses first time reports exactly one run', async () => {
  const good = { subtype: 'success', is_error: false, result: JSON.stringify(goodVerdict), usage: {}, total_cost_usd: 0.03, duration_ms: 22 }
  const out = await runReview({ criteria: 'c', pr: PR, diff: 'd', cwd: '/wt', spawnImpl: fakeSpawn([good]).impl })
  assert.equal(out.runs.length, 1)
  assert.equal(out.runs[0].costUsd, 0.03)
})

test('a review that fails outright still reports the runs it burned', async () => {
  const bad = { subtype: 'success', is_error: false, result: 'prose only', usage: {}, total_cost_usd: 0.02, duration_ms: 11 }
  const err = await runReview({ criteria: 'c', pr: PR, diff: 'd', cwd: '/wt', spawnImpl: fakeSpawn([bad, bad]).impl }).then(
    () => null,
    (e) => e,
  )
  assert.ok(err instanceof VerdictParseError)
  assert.deepEqual(err.runs.map((r) => r.costUsd), [0.02, 0.02], 'a review that produced nothing still spent quota')
})

test('isUsageLimit discriminates within errors, and does not fire on quota words in a passing run', () => {
  // Would pass for `run => Boolean(run.isError)`: an ordinary tool failure.
  assert.equal(isUsageLimit({ isError: true, result: 'Error: ENOENT: no such file or directory' }), false)
  assert.equal(isUsageLimit({ isError: true, result: 'Tool use was denied' }), false)
  // A review of rate-limiting code says "rate limit" in a perfectly good run.
  assert.equal(isUsageLimit({ isError: false, result: '{"summary":"adds a rate limit to the API"}' }), false)
  assert.equal(isUsageLimit({ isError: true, result: 'Request failed with status 429' }), true)
  assert.equal(isUsageLimit({ isError: true }), false, 'a missing result is not a quota event')
  // Digits inside a duration are not an HTTP status. This one is load-bearing:
  // the timeout message below carries an elapsed time, and reading a hung
  // review as a quota event would put it on the transient path forever.
  assert.equal(isUsageLimit({ isError: true, result: 'claude timed out after 1429ms (limit 1200000ms)' }), false)
})

test('runClaude reports a success envelope as a success and an error envelope as an error', async () => {
  const okEnv = { type: 'result', subtype: 'success', is_error: false, result: '{}', total_cost_usd: 0.5, duration_ms: 900, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 } }
  const ok = await runClaude({ prompt: 'p', cwd: '/wt', spawnImpl: fakeSpawn([okEnv]).impl })
  assert.equal(ok.isError, false)
  assert.equal(ok.durationMs, 900)
  assert.deepEqual(ok.usage, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 })
  assert.equal(ok.model, null, 'no modelUsage means no model to report, not a guess')

  const errEnv = { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', total_cost_usd: 0, duration_ms: 3, usage: {} }
  const bad = await runClaude({ prompt: 'p', cwd: '/wt', spawnImpl: fakeSpawn([errEnv]).impl })
  assert.equal(bad.isError, true)
  assert.equal(bad.result, 'boom')
})

test('runClaude survives output that is not an envelope at all', async () => {
  const { impl } = fakeSpawn(['claude: command failed\n'])
  const out = await runClaude({ prompt: 'p', cwd: '/wt', spawnImpl: impl })
  assert.equal(out.isError, true, 'unparseable output is a failed run, never an empty success')
  assert.match(out.result, /command failed/)
  assert.equal(out.costUsd, 0)
  assert.equal(out.model, null)
  assert.equal(out.exitCode, 0)
})

test('runClaude rejects when the child cannot be spawned', async () => {
  const impl = () => {
    const child = new EventEmitter()
    child.stdin = new Writable({ write(c, e, cb) { cb() }, final(cb) { cb() } })
    child.stdout = Readable.from([])
    child.stderr = Readable.from([])
    setImmediate(() => child.emit('error', new Error('spawn claude ENOENT')))
    return child
  }
  await assert.rejects(runClaude({ prompt: 'p', cwd: '/wt', spawnImpl: impl }), /ENOENT/)
})

test('parseVerdict fails as a parse error, not a crash, on a malformed findings array', () => {
  const holes = JSON.stringify({ summary: 's', findings: [null], previousBlockersResolved: [] })
  assert.throws(() => parseVerdict(holes), VerdictParseError)
  const stringy = JSON.stringify({ summary: 's', findings: ['unhandled null in a.ts'], previousBlockersResolved: [] })
  assert.throws(() => parseVerdict(stringy), VerdictParseError)
  const noClaim = JSON.stringify({ summary: 's', findings: [{ severity: 'blocking', file: 'f', line: 1, why: 'w' }], previousBlockersResolved: [] })
  assert.throws(() => parseVerdict(noClaim), VerdictParseError)
})

test('a broken pipe to the child does not take the daemon down with it', async () => {
  // The prompt is diff-sized, so a child that dies mid-write is an EPIPE on
  // stdin. An unhandled 'error' on that stream is an uncaught exception, and
  // this process runs unattended: one dead PR must not end the watch loop.
  const envelope = { subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, duration_ms: 1, usage: {} }
  const impl = () => {
    const child = new EventEmitter()
    child.stdin = new Writable({ write(c, e, cb) { cb(new Error('EPIPE: broken pipe')) } })
    child.stdout = Readable.from([JSON.stringify(envelope)])
    child.stderr = Readable.from([])
    setImmediate(() => child.emit('close', 0))
    return child
  }
  const out = await runClaude({ prompt: 'p', cwd: '/wt', spawnImpl: impl })
  assert.equal(out.result, 'ok')
})

test('previousBlockersResolved is always an array the caller can iterate', () => {
  const withShape = (v) => JSON.stringify({ summary: 's', findings: [], previousBlockersResolved: v })
  assert.deepEqual(parseVerdict(withShape(null)).previousBlockersResolved, [], 'null means none')
  assert.deepEqual(parseVerdict('{"summary":"s","findings":[]}').previousBlockersResolved, [], 'absent means none')
  // Anything else is a contract violation: handing a string to a caller that
  // iterates it turns a bad verdict into a crash one layer down.
  assert.throws(() => parseVerdict(withShape('all fixed')), VerdictParseError)
  assert.throws(() => parseVerdict(withShape({ claim: 'x' })), VerdictParseError)
})

test('a hung claude is killed and reported as a per-PR failure, not a transient one', async () => {
  const hung = hungSpawn()
  const err = await runClaude({ prompt: 'p', cwd: '/wt', spawnImpl: hung.impl, timeoutMs: 25 }).then(
    () => null,
    (e) => e,
  )
  assert.ok(err instanceof ReviewTimeoutError, 'a wedged child must not resolve as an ordinary run')
  assert.match(err.message, /timed out/i)
  assert.match(err.message, /limit 25ms/, 'the message names the budget it blew')
  assert.match(err.message, /after \d+ms/, 'and how long it actually ran, for the human reading the label')
  assert.deepEqual(hung.killed, ['SIGKILL'], 'no orphan left holding the worktree open')
  // The sticky review-error label stops after one occurrence and surfaces the
  // problem. The transient path would retry this every cycle, forever, on the
  // operator's personal quota, with nobody ever seeing a signal.
  assert.equal(isUsageLimit(err.run), false, 'a hung review is this PR\'s problem, not a quota event')
})

test('a review that finishes is not killed by its own timeout afterwards', async () => {
  const killed = []
  const good = { subtype: 'success', is_error: false, result: 'ok', usage: {}, total_cost_usd: 0, duration_ms: 1 }
  const base = fakeSpawn([good])
  const impl = (...args) => {
    const child = base.impl(...args)
    child.kill = (signal) => killed.push(signal)
    return child
  }
  const out = await runClaude({ prompt: 'p', cwd: '/wt', spawnImpl: impl, timeoutMs: 10 })
  assert.equal(out.result, 'ok')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(killed, [], 'the timer must be cleared when the child closes')
})

test('runReview does not re-ask a hung review, and still reports the attempt it burned', async () => {
  const hung = hungSpawn()
  const err = await runReview({ criteria: 'c', pr: PR, diff: 'd', cwd: '/wt', spawnImpl: hung.impl, timeoutMs: 25 }).then(
    () => null,
    (e) => e,
  )
  assert.ok(err instanceof ReviewTimeoutError)
  assert.ok(!(err instanceof VerdictParseError), 'nothing to re-ask: the child never answered')
  assert.equal(hung.spawns(), 1, 'a wedged review is not asked twice')
  assert.equal(err.runs.length, 1, 'the burned attempt is still reported to telemetry')
  assert.equal(err.runs[0].timedOut, true)
})

test('the default review timeout is generous enough for a deep review of a large PR', () => {
  // Pins the unit as much as the number: 20 * 1000 would kill legitimate reviews.
  assert.equal(DEFAULT_REVIEW_TIMEOUT_MS, 20 * 60 * 1000, 'twenty minutes, in milliseconds')
})

test('a first-round prompt says so, and names no excluded files when none were skipped', () => {
  const p = buildReviewPrompt({ criteria: 'CRIT', pr: PR, diff: 'DIFF' })
  assert.match(p, /first round/i, 'the model must know there is no prior review to reconcile')
  assert.ok(!/excluded from the diff/i.test(p), 'no skipped-files section when nothing was skipped')
  assert.ok(p.includes('CRIT') && p.includes('DIFF'))
  assert.ok(p.includes('o/r#7') && p.includes('abc1234'), 'the prompt pins which commit is under review')
})
