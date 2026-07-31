#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { resolveConfigDir, loadConfig, CONFIG_FILENAME, CRITERIA_FILENAME } from './config.mjs'
import { getInstallationToken, getBotLogin } from './github-auth.mjs'
import { createGitHub } from './github.mjs'
import { createSlack } from './slack.mjs'
import { createCheckouts } from './checkout.mjs'
import { runReview } from './review.mjs'
import { refuteBlockers } from './verify.mjs'
import { createTelemetry, summarize, resetTelemetry, DEFAULT_TELEMETRY_PATH } from './telemetry.mjs'
import { runCycle } from './cycle.mjs'
import { runDoctor } from './doctor.mjs'

// Exit codes are the API a cron wrapper or `/loop` branches on, so each one has
// to mean exactly one thing. The distinction that matters most is 3 vs 4: a
// transient abort re-queues the PR and clears itself, while a per-PR failure
// applies the sticky review-error label that no automation will ever remove.
// Paging a human for the first is how a rate limit becomes a 3am alert; not
// paging for the second is how a PR sits unreviewed forever.
export const EXIT = {
  ok: 0,
  // The operator has to change something before any run can work: bad
  // arguments, missing env, no team.json, an unreadable key, invalid config.
  config: 1,
  // doctor ran and found red checks. The command worked; the setup did not.
  unhealthy: 2,
  // The cycle stopped early on a transient condition. The affected PR keeps
  // `review-requested` and is retried next cycle — do nothing.
  aborted: 3,
  // The cycle finished, but at least one PR failed and now wears
  // `review-error`. It is never retried automatically; a human must look.
  prFailures: 4,
  // A bug in this tool. Not the operator's fault and not retryable.
  internal: 5,
}

// Thrown for everything the operator can fix from the message alone. Anything
// that is NOT one of these is a bug, and the two must not share an exit code.
class CliError extends Error {}

const USAGE = 'Usage: pr-review-bot [cycle|doctor|report] [--config <dir>] [--dry-run] [--json] [--reset]'

const COMMANDS = ['cycle', 'doctor', 'report']

// Which command accepts which flag, and where each lands in the parsed result.
// A flag the command does not implement is refused rather than ignored: the
// dangerous spelling is `report --reset --dry-run`, where --dry-run reads as
// "show me what this would do" and being ignored deletes the log anyway.
const OPTIONS = {
  '--config': { key: 'configFlag', commands: ['cycle', 'doctor'], value: 'a directory' },
  '--dry-run': { key: 'dryRun', commands: ['cycle'] },
  '--json': { key: 'json', commands: ['cycle', 'doctor', 'report'] },
  '--reset': { key: 'reset', commands: ['report'] },
}

const REQUIRED_ENV = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_INSTALLATION_ID', 'SLACK_BOT_TOKEN']

const quoted = (list) => list.map((c) => `\`${c}\``).join(' and ')

export function parseArgs(argv) {
  const args = [...argv]
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'cycle'
  if (!COMMANDS.includes(command)) {
    throw new CliError(`Unknown command "${command}". Expected one of: ${COMMANDS.join(', ')}.\n${USAGE}`)
  }
  const parsed = { command, configFlag: undefined, dryRun: false, json: false, reset: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('-')) throw new CliError(`Unexpected argument "${arg}".\n${USAGE}`)
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const spec = OPTIONS[name]
    // Silently ignoring a typo is how `cycle --dryrun` posts real reviews on
    // every labelled PR while the operator believes they asked for a preview.
    if (!spec) throw new CliError(`Unknown option "${name}".\n${USAGE}`)
    if (!spec.commands.includes(command)) {
      throw new CliError(`${name} is only accepted by ${quoted(spec.commands)}, not by \`${command}\`.\n${USAGE}`)
    }
    if (!spec.value) {
      if (eq !== -1) throw new CliError(`${name} takes no value.\n${USAGE}`)
      parsed[spec.key] = true
      continue
    }
    // The value is CONSUMED here. Scanning with indexOf/includes instead reads
    // `--config --dry-run` as both a config directory named "--dry-run" and a
    // dry run, so the bot runs for real against a directory that cannot exist.
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1)
    if (!value || value.startsWith('-')) {
      throw new CliError(`${name} needs ${spec.value}: ${name} <dir>.\n${USAGE}`)
    }
    parsed[spec.key] = value
  }
  return parsed
}

export function requireEnv(env) {
  const missing = REQUIRED_ENV.filter((k) => !env[k])
  if (missing.length) {
    throw new CliError(
      `Missing or empty required environment variable(s):\n${missing.map((m) => `  - ${m}`).join('\n')}\n` +
        `Set them in ~/.config/pr-review-bot/.env (copy .env.example) or export them in the shell that starts the bot.`
    )
  }
}

// `export FOO=bar` because people paste from a shell; the lazy value plus \s*$
// because a .env written on Windows gives every value a trailing \r, which then
// travels into an Authorization header and comes back as a 401 that names
// nothing. Inline comments are deliberately NOT stripped: a private key path
// may legitimately contain "#", and losing part of a path is worse than
// keeping a comment nobody wrote.
const DOTENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/
const stripQuotes = (v) => (/^"[\s\S]*"$/.test(v) || /^'[\s\S]*'$/.test(v) ? v.slice(1, -1) : v)

export function parseDotEnv(text) {
  const parsed = {}
  for (const line of String(text).split('\n')) {
    if (/^\s*#/.test(line)) continue
    const match = DOTENV_LINE.exec(line)
    if (match) parsed[match[1]] = stripQuotes(match[2])
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Secrets
//
// This output lands in terminals, CI logs and screenshots. Registered values
// are replaced wherever they appear — including inside a URL, a JSON error
// envelope, or a message some other module built — and the shape-based pass
// catches credentials this process never held, such as one echoed back by an
// API. Below MIN_SECRET_LENGTH nothing is registered: a two-character "secret"
// would rewrite every occurrence of those characters in unrelated output.
// ---------------------------------------------------------------------------
const MIN_SECRET_LENGTH = 8
const PEM_BLOCK_RE = /-----BEGIN[\s\S]*?-----END[^\n-]*-----/g
const TOKEN_SHAPE_RE = /gh[posur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}/g

function createSecretRegistry() {
  const secrets = new Set()
  return {
    add(value) {
      if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) secrets.add(value)
    },
    redact(value) {
      let out = typeof value === 'string' ? value : String(value)
      for (const secret of secrets) out = out.split(secret).join('[redacted]')
      return out.replace(PEM_BLOCK_RE, '[redacted private key]').replace(TOKEN_SHAPE_RE, '[redacted]')
    },
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function renderReport(summaryData, path) {
  const s = summaryData
  if (!s.reviews) {
    return `No reviews recorded in ${path} yet. Telemetry only writes while "telemetry": true is set in team.json and a cycle actually reviews something.`
  }
  return [
    `Reviews measured: ${s.reviews}`,
    `Cost per review: avg $${s.avgCostUsd.toFixed(3)}, max $${s.maxCostUsd.toFixed(3)}`,
    `Total: $${s.totalCostUsd.toFixed(2)}`,
    ...Object.entries(s.byPhase).map(([phase, v]) => `  ${phase}: ${v.calls} call(s), $${v.costUsd.toFixed(3)}`),
    ...Object.entries(s.byModel).map(
      ([model, v]) => `  ${model}: ${v.calls} call(s), ${v.inputTokens} in / ${v.outputTokens} out, $${v.costUsd.toFixed(3)}`
    ),
    '',
    `Depth 2 runs roughly 3-4x the review phase. Projected avg: $${(s.avgCostUsd * 3.5).toFixed(3)} per review.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// resolveConfigDir answers WHICH directory won but not WHY, and with four tiers
// "whose criteria just ran" must never be ambiguous — an operator editing one
// team's criteria while another team's criteria runs is a silent wrong review.
function resolveConfigWithSource({ flag, envDir, cwd, home, exists, resolveDir }) {
  let configDir
  try {
    configDir = resolveDir({ flag, env: envDir, cwd, home, exists })
  } catch (e) {
    throw new CliError(e.message)
  }
  if (flag) return { configDir, configSource: '--config' }
  if (envDir) return { configDir, configSource: 'PR_REVIEW_CONFIG_DIR' }
  return { configDir, configSource: configDir === resolve(join(cwd, '.claude', 'pr-review')) ? 'cwd' : 'home' }
}

function readConfigOrExplain({ readConfig, configDir, readFile }) {
  try {
    return readConfig(configDir, { readFile })
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new CliError(`${join(configDir, CONFIG_FILENAME)} is not valid JSON: ${e.message}`)
    }
    if (e?.code === 'ENOENT') {
      throw new CliError(
        `Could not read the team configuration in ${configDir}: ${e.message}\n` +
          `Both ${CONFIG_FILENAME} and ${CRITERIA_FILENAME} must be present there.`
      )
    }
    // validateConfig's own message already names every problem and what to do.
    throw new CliError(e.message)
  }
}

function readPrivateKey({ path, readFile }) {
  let pem
  try {
    pem = readFile(path)
  } catch (e) {
    throw new CliError(
      `Cannot read the GitHub App private key at ${path}: ${e?.code || e?.message}\n` +
        `Download the .pem from the App's settings page and point GITHUB_APP_PRIVATE_KEY_PATH at it.`
    )
  }
  // Without this, a path pointing at the wrong file surfaces as an OpenSSL
  // decoder error naming neither the file nor what is wrong with it. The
  // contents are deliberately not echoed — the file is, by assumption, a key.
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    throw new CliError(
      `${path} is not a PEM private key: it has no "-----BEGIN … PRIVATE KEY-----" header. ` +
        `(Its contents are not shown here on purpose.) Download the private key from the GitHub App's settings page.`
    )
  }
  return pem
}

// ---------------------------------------------------------------------------
// main
//
// The composition root. Every collaborator is a defaulted parameter so a test
// can observe the wiring without a network, a git binary, or a real `claude`.
// ---------------------------------------------------------------------------

export async function main(argv, options = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    home = homedir(),
    now = () => Date.now(),
    exists = existsSync,
    readFile = (p) => readFileSync(p, 'utf8'),
    telemetryPath = DEFAULT_TELEMETRY_PATH,
    dotenvPath = join(home, '.config', 'pr-review-bot', '.env'),
    resolveDir = resolveConfigDir,
    readConfig = loadConfig,
    summarizeLog = summarize,
    resetLog = resetTelemetry,
    mintToken = getInstallationToken,
    readBotLogin = getBotLogin,
    makeGitHub = createGitHub,
    makeSlack = createSlack,
    makeCheckouts = createCheckouts,
    makeTelemetry = createTelemetry,
    cycle = runCycle,
    doctor = runDoctor,
    review = runReview,
    refute = refuteBlockers,
  } = options

  const secrets = createSecretRegistry()
  const writeOut = options.log ?? console.log
  const writeErr = options.logError ?? console.error
  const log = (message) => writeOut(secrets.redact(message))
  const logError = (message) => writeErr(secrets.redact(message))

  try {
    const { command, configFlag, dryRun, json, reset } = parseArgs(argv)

    // report is purely local: it reads one JSONL file written by past cycles.
    // No GitHub App token, no Slack client, and no team.json — asking "what did
    // this cost me" must not require a working installation, or a config
    // directory, to answer.
    if (command === 'report') {
      if (!exists(telemetryPath)) {
        log(`No telemetry recorded at ${telemetryPath}. Set "telemetry": true in team.json to start measuring.`)
        return EXIT.ok
      }
      let raw
      try {
        raw = readFile(telemetryPath)
      } catch (e) {
        throw new CliError(`Cannot read the telemetry log at ${telemetryPath}: ${e?.code || e?.message}`)
      }
      const summaryData = summarizeLog(raw)
      log(json ? JSON.stringify(summaryData, null, 2) : renderReport(summaryData, telemetryPath))
      if (reset) {
        // Cleared strictly AFTER the summary has been printed, so a reset can
        // never destroy the number the operator was about to read.
        let cleared
        try {
          cleared = resetLog(telemetryPath)
        } catch (e) {
          // The summary is already on screen, so nothing was lost — but the
          // reset the operator asked for did not happen, and silently
          // reporting success would start the next measurement window on top
          // of the old numbers.
          throw new CliError(
            `The summary above is complete, but the log could not be cleared: ${telemetryPath}: ${e?.code || e?.message}`
          )
        }
        const notice = cleared
          ? `Log cleared: ${telemetryPath} deleted. The next measurement window starts empty.`
          : 'Nothing to clear.'
        // Under --json the notice is a diagnostic, not data, so it goes to
        // stderr and stdout stays pipeable into jq.
        ;(json ? logError : log)(notice)
      }
      return EXIT.ok
    }

    // Read FIRST, before any code path that can print. The redactor cannot
    // remove a token it has not been told about, and the Slack token is known
    // from here on — every message emitted below is filtered through it.
    // Process env wins over the file, as every dotenv implementation does: an
    // explicit export is a deliberate override of a saved default.
    let fileEnv = {}
    try {
      if (exists(dotenvPath)) fileEnv = parseDotEnv(readFile(dotenvPath))
    } catch (e) {
      throw new CliError(`Cannot read ${dotenvPath}: ${e?.code || e?.message}`)
    }
    const merged = { ...fileEnv, ...env }
    secrets.add(merged.SLACK_BOT_TOKEN)

    const { configDir, configSource } = resolveConfigWithSource({
      flag: configFlag,
      envDir: env.PR_REVIEW_CONFIG_DIR,
      cwd,
      home,
      exists,
      resolveDir,
    })
    const config = readConfigOrExplain({ readConfig, configDir, readFile })

    requireEnv(merged)

    const privateKeyPem = readPrivateKey({ path: merged.GITHUB_APP_PRIVATE_KEY_PATH, readFile })
    secrets.add(privateKeyPem)

    const auth = { appId: merged.GITHUB_APP_ID, privateKeyPem, nowSeconds: Math.floor(now() / 1000) }
    let installation
    try {
      installation = await mintToken({ ...auth, installationId: merged.GITHUB_APP_INSTALLATION_ID })
    } catch (e) {
      throw new CliError(
        `Could not mint a GitHub App installation token: ${e.message}\n` +
          `Check GITHUB_APP_ID (${merged.GITHUB_APP_ID}) and GITHUB_APP_INSTALLATION_ID (${merged.GITHUB_APP_INSTALLATION_ID}), ` +
          `and that ${merged.GITHUB_APP_PRIVATE_KEY_PATH} is the private key for that App. A GitHub outage looks the same from here.`
      )
    }
    const { token, permissions } = installation
    secrets.add(token)

    const github = makeGitHub({ token })
    const slack = makeSlack({ token: merged.SLACK_BOT_TOKEN })

    if (command === 'doctor') {
      const result = await doctor({
        config,
        configDir,
        configSource,
        github,
        slack,
        // The RAW process environment, not the merge. The billing check asks
        // what a `claude -p` child would authenticate as, and a child inherits
        // process.env — an ANTHROPIC_API_KEY sitting in our own .env file
        // reaches nothing, so reporting it would be a false alarm on the one
        // check that must never be ignored.
        env,
        // Exactly the shape Task 14 reads. getBotLogin is called here rather
        // than up front so that a failure lands as two red checks explaining
        // the credential could not be identified, instead of aborting doctor —
        // the command whose whole job is to report what is broken.
        appAuth: async () => ({
          tokenSource: 'app-installation',
          login: await readBotLogin(auth),
          permissions,
        }),
      })
      if (json) {
        log(JSON.stringify(result, null, 2))
      } else {
        for (const check of result.checks) log(`${check.ok ? '✓' : '✗'} ${check.name} — ${check.detail}`)
        log(result.ok ? '\nAll checks passed.' : '\nSome checks failed. Fix them before running a live cycle.')
      }
      return result.ok ? EXIT.ok : EXIT.unhealthy
    }

    let botLogin
    try {
      botLogin = await readBotLogin(auth)
    } catch (e) {
      throw new CliError(
        `Could not read the GitHub App identity: ${e.message}\n` +
          `Without it the bot cannot recognise its own past reviews and would review every PR again each cycle. Run \`pr-review-bot doctor\`.`
      )
    }

    const result = await cycle({
      config,
      dryRun,
      now: new Date(now()).toISOString(),
      deps: {
        github,
        slack,
        checkouts: makeCheckouts({
          clonesDir: config.clonesDir,
          // Every allowlisted repo may be private, and git under
          // GIT_TERMINAL_PROMPT=0 cannot ask for a password. Called per
          // worktree rather than captured once because an installation token
          // expires an hour after minting and the clone outlives it by days.
          credentialFor: () => `x-access-token:${token}`,
        }),
        runReview: review,
        // The refutation timeout is runCycle's own REFUTATION_TIMEOUT_MS (5
        // minutes): it passes it to refuteBlockers itself, so there is nothing
        // for the CLI to supply and no way for it to disagree.
        refuteBlockers: refute,
        telemetry: makeTelemetry({ enabled: config.telemetry }),
        botLogin,
        log,
      },
    })

    const counts = result.processed.reduce((acc, p) => ({ ...acc, [p.outcome]: (acc[p.outcome] || 0) + 1 }), {})
    const outcomes = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'
    if (json) {
      log(JSON.stringify(result, null, 2))
    } else {
      // One line per PR, before the totals. Counts alone cannot say WHICH PR
      // was approved and which needs changes, so a reader had to open GitHub to
      // find out. The totals stay LAST, where the slash command reads them.
      for (const p of result.processed) {
        log(`${p.repo}#${p.number} ${p.outcome}${p.verdict ? ` (${p.verdict})` : ''}`)
      }
      log(`${result.processed.length} PR(s): ${outcomes}${result.aborted ? ` — aborted: ${result.reason}` : ''}`)
    }

    // Order matters. runCycle records an `error` outcome for the PR it deferred
    // AND sets aborted, so checking failures first would report every transient
    // abort as a human-needed failure.
    if (result.aborted) return EXIT.aborted
    return result.processed.some((p) => p.outcome === 'error') ? EXIT.prFailures : EXIT.ok
  } catch (e) {
    if (e instanceof CliError) {
      logError(e.message)
      return EXIT.config
    }
    logError(`Unexpected internal failure: ${e?.message ?? e}`)
    logError('This is a bug in pr-review-bot, not a configuration problem. Re-run with PR_REVIEW_DEBUG=1 for the stack trace.')
    if (env.PR_REVIEW_DEBUG && e?.stack) logError(e.stack)
    return EXIT.internal
  }
}

// realpathSync, not argv[1] as invoked. package.json declares this file as the
// `pr-review-bot` bin, so an install puts a SYMLINK on the PATH — and Node
// resolves the main entry to its real path for import.meta.url while argv[1]
// stays the symlink. Comparing them raw made the installed command print
// nothing and exit 0, which a cron wrapper reads as a cycle that ran fine.
function invokedDirectly() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2))
    // process.exitCode, never process.exit(): process.exit truncates a piped
    // stdout mid-write, which is exactly what `report --json | jq` does.
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`Unexpected internal failure: ${e?.message ?? e}`)
      process.exitCode = EXIT.internal
    })
}
