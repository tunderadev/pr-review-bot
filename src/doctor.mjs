import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertNoSecrets } from './config.mjs'

const LABEL_COLORS = { requested: '0e8a16', inProgress: 'fbca04', error: 'b60205' }
const LABEL_DESCRIPTION = 'Managed by pr-review-bot'

// Every environment variable that takes a headless `claude -p` run off the
// operator's Claude subscription. This is the most expensive misconfiguration
// available: the loop polls every few minutes forever, so the bill accrues
// silently and nothing on screen says the run stopped being free.
const BILLING_REDIRECTS = [
  ['ANTHROPIC_API_KEY', 'authenticates as the Anthropic API and bills per token instead of drawing on your Claude subscription'],
  ['ANTHROPIC_AUTH_TOKEN', 'sends its own bearer token, so runs authenticate as something other than your Claude subscription'],
  ['ANTHROPIC_BASE_URL', 'points the CLI at a gateway rather than Anthropic, so billing and routing are whatever that gateway does'],
  ['CLAUDE_CODE_USE_BEDROCK', 'routes runs through AWS Bedrock, billed to that AWS account'],
  ['CLAUDE_CODE_USE_VERTEX', 'routes runs through Google Vertex, billed to that GCP project'],
]
// "0" and "false" are JS-truthy strings that mean disabled, and an
// exported-but-empty variable authenticates nothing. Firing on either would
// train the operator to ignore the one check that must never be ignored.
const OFF_VALUES = new Set(['', '0', 'false', 'no', 'off'])
const isActive = (value) => value != null && value !== false && !OFF_VALUES.has(String(value).trim().toLowerCase())

// What the pipeline actually spends the installation on. Anything missing here
// surfaces as a 4xx at the exact moment the work is already paid for.
const REQUIRED_PERMISSIONS = [
  ['pull_requests', 'write', 'post APPROVE / REQUEST_CHANGES reviews'],
  ['issues', 'write', 'move the review labels and maintain the sticky state comment'],
  ['contents', 'read', 'clone the PR head to review it'],
]
const PERMISSION_RANK = { none: 0, read: 1, write: 2, admin: 3 }

// Files that must never be tracked by git from inside a config directory. The
// directory is typically committed to a repo the team owns, so this is the
// last line before a live credential enters git history, where it stays.
const SECRET_FILES = ['.env', '.env.local']

// `--version` only. It resolves the binary and prints a string; it starts no
// session and makes no model call, so it costs nothing. Probing with
// `claude -p` would spend the operator's subscription quota to find out
// whether their subscription quota works, which is the wrong trade for a
// preflight that is supposed to be cheap.
const PROBE_TIMEOUT_MS = 10_000

function defaultClaudeCli() {
  const path = execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8', stdio: 'pipe', timeout: PROBE_TIMEOUT_MS }).trim()
  if (!path) throw new Error('`command -v claude` resolved nothing')
  // Executed by resolved path, so the version reported belongs to the binary
  // the check just named — not to a different `claude` earlier on PATH.
  const version = execFileSync(path, ['--version'], { encoding: 'utf8', stdio: 'pipe', timeout: PROBE_TIMEOUT_MS }).trim()
  return { path, version }
}

// Answers only "is git tracking this path right now". A config dir outside any
// repository and a machine with no git installed both answer false, which is
// the right answer for the first and an unprovable one for the second — a
// caller that can tell the difference should inject its own probe.
function defaultGitTracked(path) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', path], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// A Slack member id is only a mapping if resolveMention would actually use it:
// an own string property, non-empty. Counting anything looser reports coverage
// the runtime does not have.
const isMapping = (value) => typeof value === 'string' && value !== ''

function describeConfigDir({ configDir, configSource, env }) {
  const declared = env.PR_REVIEW_CONFIG_DIR
  const sameAsDeclared = Boolean(declared) && safeResolve(declared) === safeResolve(configDir)
  const source = configSource || (sameAsDeclared ? 'PR_REVIEW_CONFIG_DIR' : null)
  // With four resolution tiers, "whose criteria just ran" must never be
  // ambiguous — and a PR_REVIEW_CONFIG_DIR that lost to an explicit --config
  // is the exact case where an operator edits one team's criteria and watches
  // another team's criteria run.
  const shadowed = declared && !sameAsDeclared ? ` PR_REVIEW_CONFIG_DIR points at ${declared}, which did NOT win.` : ''
  return source
    ? `${configDir} (from ${source}).${shadowed}`
    : `${configDir} (matched by the default search order: --config, PR_REVIEW_CONFIG_DIR, ./.claude/pr-review, ~/.config/pr-review-bot/default).${shadowed}`
}

function safeResolve(path) {
  try {
    return resolve(path)
  } catch {
    return String(path)
  }
}

/**
 * Preflight every moving part an adopting team can get wrong, without
 * mutating a real PR.
 *
 * All I/O is injected; nothing here reaches the network or runs git on its own.
 *
 * @param appAuth optional `async () => ({ tokenSource, login, permissions })`
 *   describing the GitHub credential in use: how it was obtained
 *   ('app-installation' when minted from the App's private key), who it
 *   authenticates as (the App slug plus "[bot]", or a user login), and the
 *   permissions the installation was granted. A token string cannot answer
 *   any of that, so whoever built the client has to say.
 * @param configSource optional label for the tier that produced configDir.
 * @param claudeCli probe returning `{version, path?}` for the `claude` binary,
 *   or throwing if it cannot be resolved. Defaults to a `--version` call.
 */
export async function runDoctor({
  config,
  configDir,
  configSource,
  github,
  slack,
  env = process.env,
  gitTracked = defaultGitTracked,
  claudeCli = defaultClaudeCli,
  appAuth,
}) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  const redirects = BILLING_REDIRECTS.filter(([name]) => isActive(env[name]))
  add(
    'claude auth mode',
    redirects.length === 0,
    redirects.length
      ? `${redirects.map(([name, why]) => `${name} is set — it ${why}`).join('; ')}. ` +
        `Reviews are meant to draw on your Claude subscription, and the loop polls continuously, so this meters every cycle. ` +
        `Run \`unset ${redirects.map(([name]) => name).join(' ')}\` in the shell that starts the bot.`
      : 'No ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK or CLAUDE_CODE_USE_VERTEX — headless reviews draw on your Claude subscription.'
  )

  await addClaudeCliCheck(add, claudeCli)

  add('config dir', true, describeConfigDir({ configDir, configSource, env }))

  const leaked = SECRET_FILES.filter((f) => gitTracked(join(configDir, f)))
  add(
    'secrets not committed',
    leaked.length === 0,
    leaked.length
      ? `Tracked by git inside the config dir: ${leaked.join(', ')}. Move secrets to ~/.config/pr-review-bot/.env and \`git rm --cached\` these.`
      : `No ${SECRET_FILES.join(' or ')} tracked by git in the config dir.`
  )

  // team.json is committed to a repo the team owns, and loadConfig attaches
  // `criteria` only AFTER validateConfig ran assertNoSecrets — so the criteria
  // file's contents are scanned here and nowhere else.
  let credential = null
  try {
    assertNoSecrets(config)
  } catch (e) {
    credential = e.message
  }
  add('no credentials in config', !credential, credential ?? 'No token-shaped values in team.json or review-criteria.md.')

  await addReviewCapabilityChecks(add, appAuth)

  const repos = Array.isArray(config.repos) ? config.repos : []
  add(
    'repos configured',
    repos.length > 0,
    repos.length ? `${repos.length} repo(s) allowlisted: ${repos.join(', ')}` : 'No repos in team.json — the loop would poll nothing and report itself healthy forever.'
  )

  const openPrs = []
  for (const repo of repos) {
    try {
      const prs = await github.listOpenPrs(repo)
      if (Array.isArray(prs)) openPrs.push(...prs)
      add(`repo access: ${repo}`, true, `installation can read pull requests (${Array.isArray(prs) ? prs.length : 0} open)`)
    } catch (e) {
      // `continue`, never `break`: one repo the App was never installed on
      // must not hide the state of every repo after it in the list.
      add(`repo access: ${repo}`, false, e.message)
      continue
    }
    for (const [key, name] of Object.entries(config.labels)) {
      try {
        await github.ensureLabel(repo, name, LABEL_COLORS[key] || 'ededed', LABEL_DESCRIPTION)
        add(`label ${name} on ${repo}`, true, 'present (created if it was missing)')
      } catch (e) {
        add(`label ${name} on ${repo}`, false, e.message)
      }
    }
  }

  await addSlackChecks(add, slack, config)

  const mapped = Object.entries(config.authorMap || {}).filter(([, id]) => isMapping(id)).map(([login]) => login)
  const unmapped = [...new Set(openPrs.map((pr) => pr?.user?.login).filter(Boolean))].filter((login) => !mapped.includes(login))
  const shown = unmapped.slice(0, 5).map((l) => `@${l}`).join(', ')
  const tail = unmapped.length > 5 ? ` (+${unmapped.length - 5} more)` : ''
  // A warning, never a failure: resolveMention degrades an unmapped author to
  // unlinked text after the GitHub review is already posted, so this is
  // cosmetic — but it is invisible in the channel unless someone says it here.
  add(
    'author mapping',
    true,
    (mapped.length ? `${mapped.length} author(s) mapped.` : 'No authors mapped — mentions will be unlinked text until you add authorMap entries.') +
      (unmapped.length ? ` Open PRs by ${shown}${tail} are not in authorMap; their mentions will be unlinked text.` : mapped.length ? ' Every open PR author is covered.' : '')
  )

  add(
    'telemetry',
    true,
    config.telemetry
      ? 'Enabled — cost and token data will be written to ~/.config/pr-review-bot/telemetry.jsonl.'
      : 'Disabled (the default) — no telemetry file is written and no cost data is collected.'
  )

  return { checks, ok: checks.every((c) => c.ok) }
}

// Every review in this system is a `claude -p` subprocess. If the binary is
// not on the PATH the bot actually runs under — and a launchd or cron PATH is
// not the operator's interactive shell — then every PR fails identically and
// each one lands a sticky review-error label a human has to clear by hand.
// One line here replaces all of that.
async function addClaudeCliCheck(add, claudeCli) {
  let info = null
  let failure = null
  try {
    info = await claudeCli()
  } catch (e) {
    failure = e.message
  }
  if (!info || !info.version) {
    add(
      'claude cli',
      false,
      `\`claude\` could not be resolved${failure ? `: ${failure}` : ' — the probe returned no version'}. ` +
        `Every review runs as a \`claude -p\` subprocess, so no PR can be reviewed without it. Install Claude Code, then check the PATH the bot runs under — ` +
        `a launchd/cron PATH is not your interactive shell's, so \`which claude\` succeeding in a terminal does not settle it.`
    )
    return
  }
  add(
    'claude cli',
    true,
    `${info.version}${info.path ? ` at ${info.path}` : ''} — the binary is present and executable. ` +
      `This does not prove you are logged in: doctor makes no model call, because spending subscription quota to test whether subscription quota works is the wrong trade for a preflight. ` +
      `The first live cycle is what proves authentication.`
  )
}

// The expensive failure. A misconfigured credential — most often a personal
// token standing in for the App — is rejected with 422 "Can not approve your
// own pull request" only when the review is POSTed, which is after a full
// model review plus refutations have been bought out of the operator's quota.
// Nothing here posts a review: the two facts that make one possible are both
// readable without mutating anything.
async function addReviewCapabilityChecks(add, appAuth) {
  let auth = null
  let failure = null
  try {
    auth = appAuth ? await appAuth() : null
  } catch (e) {
    failure = e.message
  }

  if (!auth) {
    // Unverifiable is not healthy. A check that quietly does not run is the
    // precise failure this command exists to prevent, so both halves report
    // red and say which it is.
    const why = failure
      ? `could not read the installation: ${failure}`
      : appAuth
        ? 'the installation probe returned nothing, so the credential is unidentified'
        : 'no installation probe was supplied to doctor, so the credential is unidentified (wire appAuth into the CLI)'
    add('github identity', false, `Not verified — ${why}.`)
    add(
      'review capability',
      false,
      `Not verified — ${why}. Until this reads, a wrong credential surfaces as a 422 at review-post time, after the review has already been paid for.`
    )
    return
  }

  const login = typeof auth.login === 'string' ? auth.login : ''
  const asInstallation = auth.tokenSource === 'app-installation' && login.endsWith('[bot]')
  add(
    'github identity',
    asInstallation,
    asInstallation
      ? `Authenticated as the GitHub App installation ${login}, so a review it posts is not the operator approving their own PR. (A PR opened by the bot itself would still be refused.)`
      : `Authenticated as ${login || 'an unidentified credential'}${auth.tokenSource ? ` (tokenSource: ${auth.tokenSource})` : ''}, not as a GitHub App installation. ` +
        `GitHub refuses a review on your own pull request with 422 "Can not approve your own pull request" — and only at post time, after the whole review has been paid for. ` +
        `No personal token can shadow this: nothing here reads GITHUB_TOKEN, and the credential is minted only from GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH and GITHUB_APP_INSTALLATION_ID. ` +
        `Check that those three all belong to the same GitHub App installation.`
  )

  const granted = auth.permissions && typeof auth.permissions === 'object' ? auth.permissions : {}
  // Normalised: GitHub answers lowercase, but a wrapper that title-cases a
  // permission it really has would otherwise be told to grant it again.
  const rankOf = (key) => PERMISSION_RANK[String(granted[key] ?? 'none').trim().toLowerCase()] ?? 0
  const short = REQUIRED_PERMISSIONS.filter(([key, need]) => rankOf(key) < PERMISSION_RANK[need])
  add(
    'review capability',
    short.length === 0,
    short.length
      ? `The installation grants ${short.map(([key, need, why]) => `${key}: ${granted[key] ?? 'none'} (needs ${need}, to ${why})`).join('; ')}. ` +
        `Raise it under Settings → Developer settings → GitHub Apps → Permissions, then accept the pending permission request in each repository.`
      : `The installation grants pull_requests: write, issues: write and contents: read, so the App is permitted to post reviews. ` +
        `This reads the grant; it does not POST one — branch protection, repository rulesets and org review policies still apply when the real review lands.`
  )
}

async function addSlackChecks(add, slack, config) {
  const channel = config.slack.channel
  let ts
  try {
    ;({ ts } = await slack.postMessage({ channel, text: '`pr-review-bot doctor` — connectivity check.' }))
  } catch (e) {
    add(
      'slack post',
      false,
      `${e.message} — check the bot token, that the bot is a member of ${channel} (/invite it), and that the app has chat:write.`
    )
    add('slack reactions', false, `Not checked — no message could be posted to ${channel} to react to.`)
    return
  }
  if (!ts) {
    // The ts is durable state elsewhere in the pipeline; reacting against an
    // undefined one produces a confusing Slack error instead of this one.
    add('slack post', false, `Slack accepted the message to ${channel} but returned no ts, so nothing can be reacted to or threaded onto.`)
    add('slack reactions', false, 'Not checked — the connectivity message returned no ts.')
    return
  }
  add('slack post', true, `Posted ts ${ts} to ${channel}.`)

  const name = config.slack.emoji.approved
  try {
    await slack.addReaction({ channel, ts, name })
  } catch (e) {
    add('slack reactions', false, `${e.message} — reactions:write is a separate scope from chat:write; add it and reinstall the app.`)
    return
  }
  try {
    // Removal is not optional politeness: every round takes the previous state
    // emoji off before adding the new one, so a PR that went ❌ then ✅ would
    // otherwise wear both and show two contradictory states at once.
    await slack.removeReaction({ channel, ts, name })
  } catch (e) {
    add('slack reactions', false, `Adding worked but removing failed: ${e.message} — reaction reconciliation needs reactions:write for both.`)
    return
  }
  add('slack reactions', true, `Added and removed :${name}: on the check message — reactions:write is present.`)
}
