import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import { parseArgs, parseDotEnv, requireEnv, main, EXIT } from '../src/cli.mjs'
import { runReview } from '../src/review.mjs'
import { refuteBlockers } from '../src/verify.mjs'
import { runDoctor } from '../src/doctor.mjs'
import { getInstallationToken, getBotLogin } from '../src/github-auth.mjs'

// ---------------------------------------------------------------------------
// Fixtures. Secrets are realistic lengths on purpose: the redaction assertions
// below are worthless against a two-character "token".
// ---------------------------------------------------------------------------

const TOKEN = 'ghs_16C7e42F292c6912E7710c838347Ae178B4a'
const SLACK_TOKEN = 'xoxb-' + '2154537391-2158321586-A6dJmPnQr7sTuVwXyZ0bCdEf'
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7Qk9pLmNvWq3Zt\nR8sYbUfHjKl2Pd4Xa\n-----END RSA PRIVATE KEY-----\n'
const PERMISSIONS = { pull_requests: 'write', issues: 'write', contents: 'read' }

const ENV = {
  GITHUB_APP_ID: '123456',
  GITHUB_APP_PRIVATE_KEY_PATH: '/keys/app.pem',
  GITHUB_APP_INSTALLATION_ID: '987654',
  SLACK_BOT_TOKEN: SLACK_TOKEN,
}

const CONFIG = {
  team: 'platform',
  owner: 'acme',
  repos: ['acme/api'],
  titlePrefix: '^\\[plat\\]',
  slack: { channel: 'C0123ABC', emoji: { inReview: 'eyes', approved: 'white_check_mark', changesRequested: 'x', error: 'warning' } },
  labels: { requested: 'review-requested', inProgress: 'review-in-progress', error: 'review-error' },
  authorMap: {},
  maxPerCycle: 3,
  maxDiffLines: 3000,
  depth: 'standard',
  telemetry: true,
  clonesDir: '/cache/clones',
  criteria: '# criteria\n',
  configDir: '/cfg',
}

// Every seam main() has, defaulted to something inert that records. A test
// overrides only what it is about, so an unexpected call still lands somewhere
// visible rather than reaching the network.
function harness(overrides = {}) {
  const out = []
  const calls = { mintToken: [], readBotLogin: [], makeGitHub: [], makeSlack: [], makeCheckouts: [], makeTelemetry: [], cycle: [], doctor: [], resetLog: [], readFile: [], resolveDir: [], readConfig: [] }
  const github = { name: 'github-client' }
  const slack = { name: 'slack-client' }
  const telemetry = { name: 'telemetry' }
  const checkouts = { name: 'checkouts' }

  const opts = {
    env: { ...ENV },
    cwd: '/work',
    home: '/home/dev',
    now: () => 1_800_000_000_000,
    log: (m) => out.push({ stream: 'out', text: String(m) }),
    logError: (m) => out.push({ stream: 'err', text: String(m) }),
    exists: () => false,
    readFile: (p) => {
      calls.readFile.push(p)
      if (p === ENV.GITHUB_APP_PRIVATE_KEY_PATH) return PEM
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' })
    },
    resolveDir: (args) => {
      calls.resolveDir.push(args)
      return '/cfg'
    },
    readConfig: (dir) => {
      calls.readConfig.push(dir)
      return CONFIG
    },
    mintToken: async (args) => {
      calls.mintToken.push(args)
      return { token: TOKEN, expiresAt: '2026-07-31T19:00:00Z', permissions: PERMISSIONS }
    },
    readBotLogin: async (args) => {
      calls.readBotLogin.push(args)
      return 'plat-reviewer[bot]'
    },
    makeGitHub: (args) => {
      calls.makeGitHub.push(args)
      return github
    },
    makeSlack: (args) => {
      calls.makeSlack.push(args)
      return slack
    },
    makeCheckouts: (args) => {
      calls.makeCheckouts.push(args)
      return checkouts
    },
    makeTelemetry: (args) => {
      calls.makeTelemetry.push(args)
      return telemetry
    },
    cycle: async (args) => {
      calls.cycle.push(args)
      return { processed: [], aborted: false }
    },
    doctor: async (args) => {
      calls.doctor.push(args)
      return { checks: [{ name: 'x', ok: true, detail: 'fine' }], ok: true }
    },
    telemetryPath: '/home/dev/.config/pr-review-bot/telemetry.jsonl',
    resetLog: (p) => {
      calls.resetLog.push(p)
      return true
    },
    ...overrides,
  }
  return { opts, out, calls, clients: { github, slack, telemetry, checkouts } }
}

const text = (out) => out.map((l) => l.text).join('\n')
const stdout = (out) => out.filter((l) => l.stream === 'out').map((l) => l.text).join('\n')

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs defaults to cycle with no dry run and no reset', () => {
  assert.deepEqual(parseArgs([]), { command: 'cycle', configFlag: undefined, dryRun: false, json: false, reset: false, limit: undefined })
})

test('parseArgs reads --limit as a number, in both spellings', () => {
  assert.equal(parseArgs(['cycle', '--limit', '1']).limit, 1)
  assert.equal(parseArgs(['cycle', '--limit=2']).limit, 2)
  assert.equal(parseArgs(['cycle', '--dry-run', '--limit', '1']).limit, 1)
  assert.equal(parseArgs([]).limit, undefined, 'absent means "whatever maxPerCycle says"')
})

test('parseArgs rejects a --limit that is not a positive integer', () => {
  // 0 is the dangerous one: it is a number, it parses, and it would run a
  // cycle that reviews nothing while reporting success.
  for (const bad of ['0', 'abc', '1.5', '1e3', '01x', 'one', '+1']) {
    assert.throws(
      () => parseArgs(['cycle', '--limit', bad]),
      /--limit needs a positive integer/,
      `accepted --limit "${bad}"`
    )
  }
  // A negative is flag-shaped, so it reaches the missing-value branch rather
  // than the validator. It must still be refused with the SAME sentence, and
  // that sentence has to echo what was actually typed — otherwise the operator
  // is told "--limit needs a positive integer" about an argument the parser
  // never even saw, which reads as though they omitted it entirely.
  assert.throws(() => parseArgs(['cycle', '--limit', '-1']), /--limit needs a positive integer, got "-1"/)
  assert.throws(() => parseArgs(['cycle', '--limit']), /--limit needs a positive integer/)
  assert.throws(() => parseArgs(['cycle', '--limit=']), /--limit needs a positive integer/)
})

test('parseArgs accepts --limit only on cycle', () => {
  assert.throws(() => parseArgs(['doctor', '--limit', '1']), /--limit.*only.*cycle/s)
  assert.throws(() => parseArgs(['report', '--limit', '1']), /--limit.*only.*cycle/s)
})

test('parseArgs reads command, --config, --dry-run, --json, --reset', () => {
  assert.deepEqual(parseArgs(['doctor', '--config', '/c', '--json']), { command: 'doctor', configFlag: '/c', dryRun: false, json: true, reset: false, limit: undefined })
  assert.equal(parseArgs(['cycle', '--dry-run']).dryRun, true)
  assert.equal(parseArgs(['report', '--reset']).reset, true)
  assert.equal(parseArgs(['doctor', '--config=/c']).configFlag, '/c', '--config=value is the other spelling every CLI accepts')
})

test('parseArgs rejects an unknown command', () => {
  assert.throws(() => parseArgs(['frobnicate']), /Unknown command "frobnicate"/)
})

test('parseArgs rejects an unknown option instead of ignoring it', () => {
  // A typo'd flag that parses as "no flags at all" is how `cycle --dryrun`
  // posts real reviews on every labelled PR while the operator believes they
  // asked for a preview.
  assert.throws(() => parseArgs(['cycle', '--dryrun']), /Unknown option "--dryrun"/)
  assert.throws(() => parseArgs(['cycle', '-n']), /Unknown option "-n"/)
})

test('parseArgs makes --config consume its value rather than reading it as a flag', () => {
  // indexOf/includes parsing reads this as configFlag "--dry-run" AND dryRun
  // true: the bot would run for real against a config directory named after a
  // flag. The value has to be claimed by --config and nothing else.
  assert.throws(() => parseArgs(['cycle', '--config', '--dry-run']), /--config needs a directory/)
  assert.throws(() => parseArgs(['doctor', '--config']), /--config needs a directory/)
  assert.throws(() => parseArgs(['doctor', '--config=']), /--config needs a directory/)
  assert.equal(parseArgs(['cycle', '--config', '/c']).dryRun, false, '/c must not also be read as a flag')
})

test('parseArgs rejects a stray second positional', () => {
  // `pr-review-bot report reset` (no dashes) must not silently run a plain
  // report and report success for a reset that never happened.
  assert.throws(() => parseArgs(['report', 'reset']), /Unexpected argument "reset"/)
})

test('parseArgs refuses a flag the command does not implement', () => {
  // The dangerous one is `report --reset --dry-run`: --dry-run reads as "show
  // me what this would do", and silently ignoring it deletes the log anyway.
  assert.throws(() => parseArgs(['report', '--dry-run']), /--dry-run.*only.*cycle/s)
  assert.throws(() => parseArgs(['cycle', '--reset']), /--reset.*only.*report/s)
  assert.throws(() => parseArgs(['report', '--config', '/c']), /--config.*cycle.*doctor/s)
})

// ---------------------------------------------------------------------------
// requireEnv / parseDotEnv
// ---------------------------------------------------------------------------

test('requireEnv names every missing variable at once', () => {
  assert.throws(() => requireEnv({}), (e) => /GITHUB_APP_ID/.test(e.message) && /SLACK_BOT_TOKEN/.test(e.message))
  assert.doesNotThrow(() => requireEnv({ ...ENV }))
})

test('requireEnv treats an exported-but-empty variable as missing', () => {
  assert.throws(() => requireEnv({ ...ENV, SLACK_BOT_TOKEN: '' }), /SLACK_BOT_TOKEN/)
})

test('parseDotEnv strips quotes, an export prefix, and trailing carriage returns', () => {
  // A .env saved on Windows or pasted through a CRLF-preserving editor gives
  // every value a trailing \r. It travels into an Authorization header, where
  // GitHub answers 401 and nothing on screen says why.
  const parsed = parseDotEnv(
    '# comment\n' +
      'export GITHUB_APP_ID=123456\r\n' +
      'SLACK_BOT_TOKEN="xoxb-quoted"\r\n' +
      "GITHUB_APP_PRIVATE_KEY_PATH='/keys/app.pem'\n" +
      '\n' +
      'not a line\n'
  )
  assert.deepEqual(parsed, { GITHUB_APP_ID: '123456', SLACK_BOT_TOKEN: 'xoxb-' + 'quoted', GITHUB_APP_PRIVATE_KEY_PATH: '/keys/app.pem' })
})

// ---------------------------------------------------------------------------
// report — the command that must work with no credentials at all
// ---------------------------------------------------------------------------

const JSONL = [
  JSON.stringify({ repo: 'acme/api', number: 1, round: 1, phase: 'review', costUsd: 0.4, model: 'claude-x', inputTokens: 100, outputTokens: 20 }),
  JSON.stringify({ repo: 'acme/api', number: 1, round: 1, phase: 'verify', costUsd: 0.2, model: 'claude-x', inputTokens: 50, outputTokens: 10 }),
  JSON.stringify({ repo: 'acme/api', number: 2, round: 1, phase: 'review', costUsd: 1.0, model: 'claude-x', inputTokens: 100, outputTokens: 20 }),
].join('\n')

function reportHarness(overrides = {}) {
  const forbidden = (name) => (...args) => {
    throw new Error(`report reached ${name}(${JSON.stringify(args[0] ?? null)}) — it must need no credentials and no config`)
  }
  return harness({
    env: {},
    exists: (p) => p === '/home/dev/.config/pr-review-bot/telemetry.jsonl',
    readFile: (p) => {
      if (p === '/home/dev/.config/pr-review-bot/telemetry.jsonl') return JSONL
      throw new Error(`unexpected read of ${p}`)
    },
    resolveDir: forbidden('resolveConfigDir'),
    readConfig: forbidden('loadConfig'),
    mintToken: forbidden('getInstallationToken'),
    readBotLogin: forbidden('getBotLogin'),
    makeGitHub: forbidden('createGitHub'),
    makeSlack: forbidden('createSlack'),
    ...overrides,
  })
}

test('report prints the summary without minting a token, building a Slack client, or resolving config', async () => {
  // The stubs throw, so a token minted first fails the run outright — this
  // cannot pass against an implementation that authenticates and then reports.
  const { opts, out, calls } = reportHarness()
  const code = await main(['report'], opts)
  assert.equal(code, EXIT.ok, text(out))
  assert.deepEqual(calls.mintToken, [])
  assert.deepEqual(calls.makeSlack, [])
  assert.deepEqual(calls.resolveDir, [])
  assert.match(stdout(out), /Reviews measured: 2/)
  assert.match(stdout(out), /\$1\.60/, 'total across both reviews')
})

test('report --json prints the summary object and nothing else on stdout', async () => {
  const { opts, out } = reportHarness()
  const code = await main(['report', '--json'], opts)
  assert.equal(code, EXIT.ok)
  const parsed = JSON.parse(stdout(out))
  assert.equal(parsed.reviews, 2)
  assert.equal(parsed.totalCostUsd, 1.6)
})

test('report --reset prints the summary BEFORE clearing the log', async () => {
  // Ordering is the whole guarantee. An implementation that cleared first and
  // printed after would produce the same two lines and the same end state, so
  // only the sequence can tell them apart.
  const order = []
  const { opts, out } = reportHarness({
    log: (m) => order.push({ kind: 'log', text: String(m) }),
    logError: (m) => order.push({ kind: 'err', text: String(m) }),
    readFile: (p) => {
      order.push({ kind: 'read', text: p })
      return JSONL
    },
    resetLog: (p) => {
      order.push({ kind: 'reset', text: p })
      return true
    },
  })
  const code = await main(['report', '--reset'], opts)
  assert.equal(code, EXIT.ok, text(out))
  const kinds = order.map((o) => o.kind)
  const summaryAt = order.findIndex((o) => o.kind === 'log' && /Reviews measured: 2/.test(o.text))
  const resetAt = kinds.indexOf('reset')
  assert.ok(summaryAt !== -1, `no summary printed: ${JSON.stringify(order)}`)
  assert.ok(resetAt !== -1, 'the log was never cleared')
  assert.ok(kinds.indexOf('read') < resetAt, 'the log was cleared before it was read')
  assert.ok(summaryAt < resetAt, `summary printed after the clear: ${JSON.stringify(kinds)}`)
  assert.equal(order[resetAt].text, '/home/dev/.config/pr-review-bot/telemetry.jsonl')
  assert.match(order.at(-1).text, /cleared/i)
})

test('report --reset --json keeps stdout parseable and still clears after printing', async () => {
  const order = []
  const { opts } = reportHarness({
    log: (m) => order.push({ kind: 'log', text: String(m) }),
    logError: (m) => order.push({ kind: 'err', text: String(m) }),
    resetLog: () => {
      order.push({ kind: 'reset', text: '' })
      return true
    },
  })
  assert.equal(await main(['report', '--reset', '--json'], opts), EXIT.ok)
  // The notice is a diagnostic, not data: it goes to stderr so `report --json`
  // stays pipeable into jq.
  JSON.parse(order.filter((o) => o.kind === 'log').map((o) => o.text).join('\n'))
  const kinds = order.map((o) => o.kind)
  assert.ok(kinds.indexOf('log') < kinds.indexOf('reset'), 'cleared before the summary reached stdout')
  assert.equal(kinds.at(-1), 'err', 'the cleared notice must not land on stdout')
})

test('report without --reset never clears the log', async () => {
  const { opts, calls } = reportHarness()
  assert.equal(await main(['report'], opts), EXIT.ok)
  assert.deepEqual(calls.resetLog, [])
})

test('report with no telemetry file says so and clears nothing', async () => {
  const { opts, out, calls } = reportHarness({ exists: () => false })
  const code = await main(['report', '--reset'], opts)
  assert.equal(code, EXIT.ok)
  assert.match(stdout(out), /No telemetry/i)
  assert.match(stdout(out), /telemetry/i)
  assert.deepEqual(calls.resetLog, [], 'nothing to clear, so nothing may be deleted')
})

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

test('doctor hands runDoctor an async zero-arg appAuth describing the installation', async () => {
  const { opts, calls } = harness()
  const code = await main(['doctor'], opts)
  assert.equal(code, EXIT.ok)
  const args = calls.doctor[0]
  assert.equal(typeof args.appAuth, 'function')
  assert.equal(args.appAuth.length, 0, 'Task 14 calls appAuth() with no arguments')
  assert.deepEqual(await args.appAuth(), {
    tokenSource: 'app-installation',
    login: 'plat-reviewer[bot]',
    permissions: PERMISSIONS,
  })
})

test('doctor reports which of the four config tiers won', async () => {
  const tiers = [
    { argv: ['doctor', '--config', '/c'], env: {}, dir: '/c', source: '--config' },
    { argv: ['doctor'], env: { PR_REVIEW_CONFIG_DIR: '/e' }, dir: '/e', source: 'PR_REVIEW_CONFIG_DIR' },
    { argv: ['doctor'], env: {}, dir: resolve(join('/work', '.claude', 'pr-review')), source: 'cwd' },
    { argv: ['doctor'], env: {}, dir: '/home/dev/.config/pr-review-bot/default', source: 'home' },
  ]
  for (const tier of tiers) {
    const { opts, calls } = harness({
      env: { ...ENV, ...tier.env },
      resolveDir: (a) => {
        calls.resolveDir.push(a)
        return tier.dir
      },
    })
    assert.equal(await main(tier.argv, opts), EXIT.ok)
    assert.equal(calls.doctor[0].configSource, tier.source, `tier ${tier.source}`)
    assert.equal(calls.doctor[0].configDir, tier.dir)
    assert.equal(calls.resolveDir[0].flag, tier.argv.includes('--config') ? '/c' : undefined)
    assert.equal(calls.resolveDir[0].env, tier.env.PR_REVIEW_CONFIG_DIR)
  }
})

test("doctor sees the process environment, not the .env file the claude child never inherits", async () => {
  // The billing check asks what a `claude -p` child would authenticate as, and
  // a child inherits process.env. ANTHROPIC_API_KEY sitting in our own .env
  // file reaches nothing, so reporting it as a redirect is a false alarm on
  // the one check that must never be ignored.
  const { opts, calls } = harness({
    env: { ...ENV },
    exists: (p) => p === '/home/dev/.config/pr-review-bot/.env',
    readFile: (p) => {
      if (p === '/home/dev/.config/pr-review-bot/.env') return 'ANTHROPIC_API_KEY=sk-ant-api03-not-really\n'
      if (p === ENV.GITHUB_APP_PRIVATE_KEY_PATH) return PEM
      throw new Error(`unexpected read ${p}`)
    },
  })
  assert.equal(await main(['doctor'], opts), EXIT.ok)
  assert.equal(calls.doctor[0].env.ANTHROPIC_API_KEY, undefined)
})

test('doctor exits 2 when a check is red and prints every check', async () => {
  const { opts, out } = harness({
    doctor: async () => ({
      checks: [
        { name: 'claude cli', ok: true, detail: 'present' },
        { name: 'slack post', ok: false, detail: 'not_in_channel' },
      ],
      ok: false,
    }),
  })
  const code = await main(['doctor'], opts)
  assert.equal(code, EXIT.unhealthy)
  assert.match(stdout(out), /claude cli/)
  assert.match(stdout(out), /slack post/)
  assert.match(stdout(out), /not_in_channel/)
})

test('doctor --json emits the whole result', async () => {
  const { opts, out } = harness()
  assert.equal(await main(['doctor', '--json'], opts), EXIT.ok)
  assert.equal(JSON.parse(stdout(out)).ok, true)
})

// Runs the REAL runDoctor with only its two subprocess probes stubbed, so the
// options main() builds are checked against the code that actually reads them
// rather than against a fixture that agrees with me.
function realDoctorHarness(overrides = {}) {
  const results = []
  return {
    results,
    ...harness({
      makeGitHub: () => ({ listOpenPrs: async () => [], ensureLabel: async () => ({}) }),
      makeSlack: () => ({ postMessage: async () => ({ ts: '1.1' }), addReaction: async () => ({}), removeReaction: async () => ({}) }),
      doctor: async (args) => {
        const result = await runDoctor({ ...args, gitTracked: () => false, claudeCli: () => ({ version: '2.0.0', path: '/usr/local/bin/claude' }) })
        results.push(result)
        return result
      },
      ...overrides,
    }),
  }
}

test("the appAuth the CLI builds satisfies the real runDoctor's identity and capability checks", async () => {
  // Every other doctor test stubs runDoctor, so none of them proves the shape
  // is the one Task 14 actually reads.
  const { opts, results, out } = realDoctorHarness()
  const code = await main(['doctor'], opts)
  const checks = results[0].checks
  const identity = checks.find((c) => c.name === 'github identity')
  const capability = checks.find((c) => c.name === 'review capability')
  assert.ok(identity?.ok, `github identity red: ${identity?.detail}`)
  assert.ok(capability?.ok, `review capability red: ${capability?.detail}`)
  assert.equal(code, EXIT.ok, text(out))
})

test('the real github-auth module, wired through main, reaches doctor as a verified grant', async () => {
  // The seam above stubs mintToken, so nothing there proves main() calls the
  // real getInstallationToken with arguments it accepts, nor that the
  // `permissions` it returns survives the destructure. Only fetch is faked.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url.endsWith('/access_tokens')) {
      return { ok: true, status: 201, json: async () => ({ token: TOKEN, expires_at: '2026-07-31T19:00:00Z', permissions: PERMISSIONS }) }
    }
    if (url.endsWith('/app')) return { ok: true, status: 200, json: async () => ({ slug: 'plat-reviewer' }) }
    throw new Error(`unexpected fetch ${url}`)
  }
  const { opts, results, out } = realDoctorHarness({
    readFile: (p) => {
      if (p === ENV.GITHUB_APP_PRIVATE_KEY_PATH) return privateKey
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' })
    },
    mintToken: (args) => getInstallationToken({ ...args, fetchImpl }),
    readBotLogin: (args) => getBotLogin({ ...args, fetchImpl }),
  })
  const code = await main(['doctor'], opts)
  assert.equal(code, EXIT.ok, text(out))
  assert.deepEqual(seen, ['https://api.github.com/app/installations/987654/access_tokens', 'https://api.github.com/app'])
  const capability = results[0].checks.find((c) => c.name === 'review capability')
  assert.ok(capability?.ok, `review capability red: ${capability?.detail}`)
  assert.ok(results[0].checks.find((c) => c.name === 'github identity')?.ok)
  assertNoSecrets(out)
})

test('a failure inside appAuth is reported by doctor, not thrown out of the CLI', async () => {
  const { opts, results, out } = realDoctorHarness({
    readBotLogin: async () => {
      throw new Error('GET /app failed (401)')
    },
  })
  const code = await main(['doctor'], opts)
  assert.equal(code, EXIT.unhealthy, 'an unidentifiable credential is a red check, not a crash')
  const checks = results[0].checks
  assert.equal(checks.find((c) => c.name === 'github identity').ok, false)
  assert.match(checks.find((c) => c.name === 'review capability').detail, /401/)
  noStack(out)
})

// ---------------------------------------------------------------------------
// cycle wiring
// ---------------------------------------------------------------------------

test('cycle constructs every collaborator from the resolved config and minted token', async () => {
  const { opts, calls, clients } = harness()
  const code = await main([], opts)
  assert.equal(code, EXIT.ok)

  assert.deepEqual(calls.mintToken[0], {
    appId: '123456',
    privateKeyPem: PEM,
    installationId: '987654',
    nowSeconds: 1_800_000_000,
  })
  assert.deepEqual(calls.makeGitHub[0], { token: TOKEN })
  assert.deepEqual(calls.makeSlack[0], { token: SLACK_TOKEN })
  assert.deepEqual(calls.makeTelemetry[0], { enabled: true })
  assert.equal(calls.makeCheckouts[0].clonesDir, '/cache/clones')

  const args = calls.cycle[0]
  assert.equal(args.config, CONFIG)
  assert.equal(args.dryRun, false)
  assert.equal(args.deps.github, clients.github)
  assert.equal(args.deps.slack, clients.slack)
  assert.equal(args.deps.checkouts, clients.checkouts)
  assert.equal(args.deps.telemetry, clients.telemetry)
  assert.equal(args.deps.botLogin, 'plat-reviewer[bot]')
  assert.equal(args.deps.runReview, runReview, 'the real review runner, not a lookalike')
  assert.equal(args.deps.refuteBlockers, refuteBlockers)
  assert.equal(typeof args.deps.log, 'function')
})

test('cycle gives the checkout an installation credential so a private clone can authenticate', async () => {
  // Without this every private repo fails `git clone` under
  // GIT_TERMINAL_PROMPT=0 and earns the sticky review-error label.
  const { opts, calls } = harness()
  await main([], opts)
  const { credentialFor } = calls.makeCheckouts[0]
  assert.equal(typeof credentialFor, 'function')
  assert.equal(credentialFor('acme/api'), `x-access-token:${TOKEN}`)
})

test('cycle --dry-run reaches runCycle as dryRun', async () => {
  const { opts, calls } = harness()
  assert.equal(await main(['cycle', '--dry-run'], opts), EXIT.ok)
  assert.equal(calls.cycle[0].dryRun, true)
})

test('--limit overrides maxPerCycle for this invocation only', async () => {
  // The tuning loop is edit -> dry-run -> read -> edit, and every iteration
  // otherwise pays for maxPerCycle reviews out of the operator's personal
  // subscription when they need to see one rule act on one PR.
  const { opts, calls } = harness()
  assert.equal(await main(['cycle', '--dry-run', '--limit', '1'], opts), EXIT.ok)
  assert.equal(calls.cycle[0].config.maxPerCycle, 1)
  assert.equal(CONFIG.maxPerCycle, 3, 'the loaded config object must not be mutated')
  // Everything else about the config has to survive the override.
  assert.equal(calls.cycle[0].config.criteria, CONFIG.criteria)
  assert.equal(calls.cycle[0].config.clonesDir, CONFIG.clonesDir)
})

test('--limit applies to a live cycle too, not just a dry run', async () => {
  // Babysitting exactly one real review is the same legitimate need.
  const { opts, calls } = harness()
  assert.equal(await main(['cycle', '--limit', '2'], opts), EXIT.ok)
  assert.equal(calls.cycle[0].dryRun, false)
  assert.equal(calls.cycle[0].config.maxPerCycle, 2)
})

test('omitting --limit leaves maxPerCycle exactly as configured', async () => {
  const { opts, calls } = harness()
  assert.equal(await main([], opts), EXIT.ok)
  assert.equal(calls.cycle[0].config.maxPerCycle, 3)
  assert.equal(calls.cycle[0].config, CONFIG, 'no --limit means the config is passed through untouched')
})

test('a malformed --limit is a usage error, not a stack trace', async () => {
  const { opts, out } = harness()
  const code = await main(['cycle', '--limit', '0'], opts)
  assert.equal(code, EXIT.config)
  assert.match(text(out), /--limit needs a positive integer/)
  noStack(out)
})

test('a clean cycle exits 0 and summarises the outcomes', async () => {
  const { opts, out } = harness({
    cycle: async () => ({
      processed: [
        { repo: 'acme/api', number: 1, outcome: 'reviewed', verdict: 'approved' },
        { repo: 'acme/api', number: 2, outcome: 'skipped_same_sha' },
      ],
      aborted: false,
    }),
  })
  assert.equal(await main([], opts), EXIT.ok)
  assert.match(stdout(out), /2 PR\(s\)/)
  assert.match(stdout(out), /1 reviewed/)
  assert.match(stdout(out), /1 skipped_same_sha/)
})

test('the summary names each PR and its verdict, then the totals', async () => {
  // Counts alone cannot tell an operator which PR was approved and which needs
  // changes, so /pr-watch had to send them to GitHub to find out.
  const { opts, out } = harness({
    cycle: async () => ({
      processed: [
        { repo: 'acme/api', number: 12, outcome: 'reviewed', verdict: 'approved' },
        { repo: 'acme/web', number: 3, outcome: 'reviewed', verdict: 'changes_requested' },
        { repo: 'acme/api', number: 9, outcome: 'skipped_same_sha' },
        { repo: 'acme/web', number: 4, outcome: 'error' },
      ],
      aborted: false,
    }),
  })
  assert.equal(await main([], opts), EXIT.prFailures)
  const lines = stdout(out).split('\n')
  assert.ok(lines.includes('acme/api#12 reviewed (approved)'), stdout(out))
  assert.ok(lines.includes('acme/web#3 reviewed (changes_requested)'), stdout(out))
  assert.ok(lines.includes('acme/api#9 skipped_same_sha'), 'an outcome with no verdict carries no empty parens')
  assert.ok(lines.includes('acme/web#4 error'), stdout(out))
  // The per-PR lines come first so the totals stay the LAST line, which is what
  // the slash command reads.
  assert.match(lines.at(-1), /^4 PR\(s\): 2 reviewed, 1 skipped_same_sha, 1 error$/)
})

test('a dry run names the PRs it previewed', async () => {
  const { opts, out } = harness({
    cycle: async () => ({ processed: [{ repo: 'acme/api', number: 12, outcome: 'dry_run', verdict: 'changes_requested' }], aborted: false }),
  })
  assert.equal(await main(['cycle', '--dry-run'], opts), EXIT.ok)
  assert.ok(stdout(out).split('\n').includes('acme/api#12 dry_run (changes_requested)'), stdout(out))
})

test('--json still emits only the structured result, with no per-PR prose', async () => {
  const { opts, out } = harness({
    cycle: async () => ({
      processed: [
        { repo: 'acme/api', number: 12, outcome: 'reviewed', verdict: 'approved' },
        { repo: 'acme/web', number: 4, outcome: 'error' },
      ],
      aborted: false,
    }),
  })
  assert.equal(await main(['cycle', '--json'], opts), EXIT.prFailures)
  const parsed = JSON.parse(stdout(out))
  assert.equal(parsed.processed[0].verdict, 'approved')
  assert.equal(parsed.processed.length, 2)
})

test('a transient abort exits 3, distinct from a per-PR failure', async () => {
  // runCycle pushes an `error` outcome for the PR it deferred AND sets
  // aborted, so a scheme that checked errors first would report every
  // transient abort as a human-needed failure and page someone at 3am for a
  // rate limit that clears itself.
  const { opts, out } = harness({
    cycle: async () => ({
      processed: [{ repo: 'acme/api', number: 1, outcome: 'error' }],
      aborted: true,
      reason: 'usage limit reached',
    }),
  })
  assert.equal(await main([], opts), EXIT.aborted)
  assert.match(stdout(out), /aborted/i)
  assert.match(stdout(out), /usage limit reached/)
})

test('a completed cycle carrying a per-PR failure exits 4', async () => {
  const { opts } = harness({
    cycle: async () => ({
      processed: [
        { repo: 'acme/api', number: 1, outcome: 'reviewed', verdict: 'approved' },
        { repo: 'acme/api', number: 2, outcome: 'error' },
      ],
      aborted: false,
    }),
  })
  assert.equal(await main([], opts), EXIT.prFailures)
})

test('cycle --json prints the raw result', async () => {
  const { opts, out } = harness({
    cycle: async () => ({ processed: [{ repo: 'acme/api', number: 1, outcome: 'reviewed', verdict: 'approved' }], aborted: false }),
  })
  assert.equal(await main(['cycle', '--json'], opts), EXIT.ok)
  assert.equal(JSON.parse(stdout(out)).processed[0].number, 1)
})

// ---------------------------------------------------------------------------
// Actionable errors — never a stack trace
// ---------------------------------------------------------------------------

const noStack = (out) => assert.doesNotMatch(text(out), /\n\s+at .+:\d+:\d+/, `stack trace leaked:\n${text(out)}`)

test('a missing team.json is a configuration error naming the file', async () => {
  const { opts, out } = harness({
    resolveDir: () => {
      throw new Error('No team.json found. Searched:\n  /work/.claude/pr-review\n  /home/dev/.config/pr-review-bot/default\nCopy config/team.example.json into one of these directories.')
    },
  })
  const code = await main([], opts)
  assert.equal(code, EXIT.config)
  assert.match(text(out), /team\.json/)
  assert.match(text(out), /Copy config\/team\.example\.json/)
  noStack(out)
})

test('a missing environment variable is a configuration error naming all of them', async () => {
  const { opts, out } = harness({ env: { GITHUB_APP_ID: '1' } })
  const code = await main([], opts)
  assert.equal(code, EXIT.config)
  assert.match(text(out), /GITHUB_APP_PRIVATE_KEY_PATH/)
  assert.match(text(out), /GITHUB_APP_INSTALLATION_ID/)
  assert.match(text(out), /SLACK_BOT_TOKEN/)
  assert.match(text(out), /\.env/)
  noStack(out)
})

test('an unreadable private key is a configuration error naming the path', async () => {
  const { opts, out } = harness({
    readFile: (p) => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' })
    },
  })
  const code = await main([], opts)
  assert.equal(code, EXIT.config)
  assert.match(text(out), /\/keys\/app\.pem/)
  assert.match(text(out), /EACCES/)
  noStack(out)
})

test('a private key path pointing at something that is not a PEM says so', async () => {
  const { opts, out } = harness({ readFile: () => '{"client_email": "not-a-pem"}\n' })
  const code = await main([], opts)
  assert.equal(code, EXIT.config)
  assert.match(text(out), /not a PEM private key/i)
  assert.doesNotMatch(text(out), /client_email/, 'the file contents must never be echoed')
  noStack(out)
})

test('an invalid team.json is a configuration error carrying the validator message', async () => {
  const { opts, out } = harness({
    readConfig: () => {
      throw new Error('Invalid team.json:\n  - missing required key "slack"')
    },
  })
  const code = await main([], opts)
  assert.equal(code, EXIT.config)
  assert.match(text(out), /missing required key "slack"/)
  noStack(out)
})

test('an unknown command exits 1 with usage, not a stack trace', async () => {
  const { opts, out } = harness()
  const code = await main(['frobnicate'], opts)
  assert.equal(code, EXIT.config)
  assert.match(text(out), /Unknown command "frobnicate"/)
  assert.match(text(out), /cycle/)
  noStack(out)
})

test('an unexpected failure inside the cycle exits 5, separately from a config error', async () => {
  const { opts, out } = harness({
    cycle: async () => {
      throw new TypeError('deps.checkouts.worktreeForPr is not a function')
    },
  })
  const code = await main([], opts)
  assert.equal(code, EXIT.internal)
  assert.match(text(out), /worktreeForPr is not a function/)
  noStack(out)
})

test('a token that cannot be minted is a configuration error that does not echo the key', async () => {
  const { opts, out } = harness({
    mintToken: async () => {
      throw new Error('Installation token request failed (401): {"message":"A JSON web token could not be decoded"}')
    },
  })
  const code = await main([], opts)
  assert.equal(code, EXIT.config)
  assert.match(text(out), /401/)
  assert.match(text(out), /GITHUB_APP_INSTALLATION_ID|installation/i)
  noStack(out)
})

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SECRETS = [
  ['installation token', TOKEN],
  ['slack bot token', SLACK_TOKEN],
  ['private key body', 'MIIEowIBAAKCAQEAx7Qk9pLmNvWq3Zt'],
]

function assertNoSecrets(out) {
  const full = text(out)
  const leaked = SECRETS.filter(([, secret]) => full.includes(secret)).map(([name]) => name)
  assert.deepEqual(leaked, [], `secrets reached the terminal (${leaked.join(', ')}):\n${full}`)
}

test('no secret reaches stdout or stderr when the cycle logs them back at us', async () => {
  // The whole captured output is scanned, not one expected string: this is the
  // assertion that survives someone adding a new log line later.
  const { opts, out } = harness({
    cycle: async ({ deps }) => {
      deps.log(`clone failed: https://x-access-token:${TOKEN}@github.com/acme/api.git`)
      deps.log(`slack rejected ${SLACK_TOKEN}`)
      deps.log(`key was ${PEM}`)
      return { processed: [], aborted: false }
    },
  })
  assert.equal(await main([], opts), EXIT.ok)
  assertNoSecrets(out)
  assert.match(text(out), /\[redacted/, 'the line still has to say something was removed')
})

test('no secret reaches the terminal through an error message', async () => {
  const { opts, out } = harness({
    cycle: async () => {
      throw new Error(`GitHub POST /repos failed (401) with authorization: Bearer ${TOKEN} and ${SLACK_TOKEN}`)
    },
  })
  assert.equal(await main([], opts), EXIT.internal)
  assertNoSecrets(out)
})

test('no secret reaches the terminal through a doctor check detail', async () => {
  const { opts, out } = harness({
    doctor: async () => ({ checks: [{ name: 'slack post', ok: false, detail: `invalid_auth for ${SLACK_TOKEN}` }], ok: false }),
  })
  assert.equal(await main(['doctor'], opts), EXIT.unhealthy)
  assertNoSecrets(out)
})

// No vendor prefix, so the shape-based pass cannot see it: only a value the
// registry was actually told about is removed. This is what proves the
// registry is load-bearing rather than shadowed by the regexes.
const OPAQUE_TOKEN = 'b7c19d4e2f8a05316d9c4b7e2a1f80937c5e46ab'

test('an opaque credential the shape rules cannot recognise is still redacted', async () => {
  const { opts, out } = harness({
    env: { ...ENV, SLACK_BOT_TOKEN: OPAQUE_TOKEN },
    cycle: async ({ deps }) => {
      deps.log(`slack rejected ${OPAQUE_TOKEN}`)
      return { processed: [], aborted: false }
    },
  })
  assert.equal(await main([], opts), EXIT.ok)
  assert.doesNotMatch(text(out), new RegExp(OPAQUE_TOKEN), `an unrecognised credential leaked:\n${text(out)}`)
  assert.match(text(out), /\[redacted\]/)
})

test('a credential this process never held is redacted on shape alone', async () => {
  // The registry only knows what the CLI minted or read. A token echoed back
  // by an API, or one baked into a remote URL by an operator's git config,
  // reaches the log having never passed through here — which is what the
  // shape rules are for, and the only case that can tell them apart from the
  // registry.
  const foreign = 'ghp_9tKd2xQm7bVn4Lp8Rc3Wf6Zy1Ha5Ju0Sg2E'
  const { opts, out } = harness({
    cycle: async ({ deps }) => {
      deps.log(`git fetch failed: https://${foreign}@github.com/acme/api.git not found`)
      return { processed: [], aborted: false }
    },
  })
  assert.equal(await main([], opts), EXIT.ok)
  assert.doesNotMatch(text(out), new RegExp(foreign), `a foreign credential leaked:\n${text(out)}`)
  assert.match(text(out), /git fetch failed/, 'the diagnostic itself still has to survive')
})

test('a secret is redacted out of a failure raised before the credentials are even used', async () => {
  // The registry has to be loaded before the first code path that can print,
  // not just before the first one that holds a token. Resolving config first
  // left every config-time message unfiltered — and an opaque token is the
  // only fixture that can tell the registry apart from the shape rules.
  const { opts, out } = harness({
    env: { ...ENV, SLACK_BOT_TOKEN: OPAQUE_TOKEN },
    readConfig: () => {
      throw new Error(`Invalid team.json:\n  - value at "slack.token" looks like ${OPAQUE_TOKEN}`)
    },
  })
  assert.equal(await main([], opts), EXIT.config)
  assert.doesNotMatch(text(out), new RegExp(OPAQUE_TOKEN), `an unrecognised credential leaked:\n${text(out)}`)
})

test('an unreadable telemetry log is a configuration error, not an internal one', async () => {
  const { opts, out } = reportHarness({
    exists: () => true,
    readFile: (p) => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' })
    },
  })
  assert.equal(await main(['report'], opts), EXIT.config)
  assert.match(text(out), /EACCES/)
  noStack(out)
})

test('a --reset that cannot delete the log says so instead of reporting success', async () => {
  // The summary is already printed, so nothing is lost — but claiming the
  // window was cleared when it was not makes the next report double-count.
  const { opts, out } = reportHarness({
    resetLog: () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    },
  })
  assert.equal(await main(['report', '--reset'], opts), EXIT.config)
  assert.match(stdout(out), /Reviews measured: 2/, 'the summary still has to reach the operator')
  assert.match(text(out), /could not be cleared/)
  assert.doesNotMatch(text(out), /Log cleared/)
  noStack(out)
})

test('an unreadable .env is a configuration error naming the file', async () => {
  const { opts, out } = harness({
    exists: (p) => p === '/home/dev/.config/pr-review-bot/.env',
    readFile: (p) => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' })
    },
  })
  assert.equal(await main([], opts), EXIT.config)
  assert.match(text(out), /\/home\/dev\/\.config\/pr-review-bot\/\.env/)
  noStack(out)
})

test('a value too short to be a credential is never registered for redaction', async () => {
  // Registering a three-character "secret" rewrites every occurrence of those
  // characters in unrelated output — here the repo name itself. The fixture is
  // chosen so a missing length guard corrupts a line the operator has to read.
  const { opts, out } = harness({
    env: { ...ENV, SLACK_BOT_TOKEN: 'api' },
    cycle: async ({ deps }) => {
      deps.log('reviewed acme/api#123456 in 1 round')
      return { processed: [], aborted: false }
    },
  })
  await main([], opts)
  assert.match(stdout(out), /reviewed acme\/api#123456 in 1 round/)
})

test('the CLI still runs when invoked through a symlink, as an npm bin install does', async () => {
  // package.json declares this file as the `pr-review-bot` bin, so the
  // installed command IS a symlink. Node resolves the main entry to its real
  // path for import.meta.url while process.argv[1] stays the symlink, so
  // comparing them raw made the installed command print nothing and exit 0 —
  // which a cron wrapper reads as a cycle that ran fine.
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-bot-bin-'))
  try {
    const link = join(dir, 'pr-review-bot')
    symlinkSync(fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), link)
    // A HOME with no telemetry file, so the run is deterministic and touches
    // no network, no git and no claude.
    const { stdout: printed } = await execFileAsync(process.execPath, [link, 'report'], { env: { ...process.env, HOME: dir } })
    assert.match(printed, /No telemetry recorded/, `the symlinked binary printed nothing: ${JSON.stringify(printed)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
