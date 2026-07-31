import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const CONFIG_FILENAME = 'team.json'
export const CRITERIA_FILENAME = 'review-criteria.md'

// Matched against the key with separators removed, so api_key / api-key /
// apiKey all normalize to the same spelling.
const SECRET_KEY_RE = /token|secret|password|privatekey|apikey|credential/
const KEY_TOKEN_SPLIT = /[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])/
// Unanchored, because credentials get pasted mid-string ("Bearer ghs_…",
// "use ghp_… to test"), with leading whitespace, or glued to a preceding word
// ("SLACK_TOKEN_xoxb-…") — a \b before the prefix cannot fire after a word
// character, so it missed exactly the shapes a .env dump produces.
//
// Every prefix therefore demands a plausible secret BODY rather than the bare
// prefix. A prefix alone is not a leak, and rejecting one hard-fails startup
// with a message accusing the team of committing a credential — over a
// SvelteKit repo name ("acme/sk-tools") or a cache path ("/home/me/sk-clones").
// Real tokens are long unbroken alphanumeric runs; human-readable names are
// short segments joined by separators, which is what tells them apart.
const SECRET_VALUE_RE = new RegExp(
  [
    // Slack: xoxb-<workspace>-<id>-<secret>. No non-credential string contains
    // "xox", so the body only has to be more than a mention of the prefix.
    'xox[baprs]-[A-Za-z0-9-]{10,}',
    // GitHub: ghp_/gho_/ghs_/ghu_/ghr_ plus 36 alphanumerics; fine-grained PATs
    // are github_pat_ plus a much longer alphanumeric/underscore body.
    'gh[posur]_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    // Model-provider keys: sk-, sk-proj-, sk-ant-api03- … then a long
    // alphanumeric run. Hyphenated words never reach the run length, so
    // "sk-clones" and "sk-cache-of-review-clones" are ordinary strings.
    'sk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9]{20,}',
    '-----BEGIN',
  ].join('|')
)

function isSecretShapedKey(key) {
  if (SECRET_KEY_RE.test(key.toLowerCase().replace(/[^a-z]/g, ''))) return true
  // A key that ENDS in "pat" names a personal access token (pat, githubPat,
  // github_pat). A leading "pat" is a word fragment — patStrategy, pat_dirs,
  // PAT_DIRS, patch, path — and rejecting those hard-fails startup.
  const tokens = key.split(KEY_TOKEN_SPLIT).filter(Boolean)
  return tokens.at(-1)?.toLowerCase() === 'pat'
}

export function resolveConfigDir({ flag, env, cwd = process.cwd(), home = homedir(), exists = existsSync }) {
  // An explicit directory is an instruction, not a suggestion. Falling through
  // from a typo would run the bot under a different team's profile — different
  // repos, criteria, and Slack channel — and post real reviews under it.
  for (const [source, dir] of [['--config', flag], ['PR_REVIEW_CONFIG_DIR', env]]) {
    if (!dir) continue
    if (exists(join(dir, CONFIG_FILENAME))) return resolve(dir)
    throw new Error(`${source} points at ${dir}, which contains no ${CONFIG_FILENAME}. Fix the path or drop the setting to fall back to the default locations.`)
  }
  const candidates = [join(cwd, '.claude', 'pr-review'), join(home, '.config', 'pr-review-bot', 'default')]
  for (const dir of candidates) {
    if (exists(join(dir, CONFIG_FILENAME))) return resolve(dir)
  }
  throw new Error(
    `No ${CONFIG_FILENAME} found. Searched:\n${candidates.map((c) => `  ${c}`).join('\n')}\n` +
      `Copy config/team.example.json into one of these directories.`
  )
}

export function assertNoSecrets(raw, path = '') {
  for (const [key, value] of Object.entries(raw)) {
    const here = path ? `${path}.${key}` : key
    if (value && typeof value === 'object') {
      assertNoSecrets(value, here)
      continue
    }
    if (isSecretShapedKey(key)) {
      throw new Error(`Secret-shaped key "${here}" in ${CONFIG_FILENAME}. Secrets belong in ~/.config/pr-review-bot/.env, never in config.`)
    }
    if (typeof value === 'string' && SECRET_VALUE_RE.test(value)) {
      throw new Error(`Value at "${here}" looks like a credential. Secrets belong in ~/.config/pr-review-bot/.env, never in config.`)
    }
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const describeType = (value) => (Array.isArray(value) ? 'an array' : value === null ? 'null' : `a ${typeof value}`)

export function validateConfig(raw) {
  const problems = []
  for (const key of ['team', 'owner', 'repos', 'titlePrefix', 'slack']) {
    if (raw[key] === undefined) problems.push(`missing required key "${key}"`)
  }
  if (raw.repos !== undefined && (!Array.isArray(raw.repos) || raw.repos.length === 0)) {
    problems.push('"repos" must be a non-empty array of "owner/name" strings')
  }
  // Types are checked before use: null stringifies to the regex /null/ and
  // selects nothing, {} to /[object Object]/ which matches almost every title.
  if (raw.titlePrefix !== undefined) {
    if (typeof raw.titlePrefix !== 'string') {
      problems.push(`"titlePrefix" must be a string, got ${describeType(raw.titlePrefix)}`)
    } else {
      try { new RegExp(raw.titlePrefix) } catch { problems.push(`"titlePrefix" is not a valid regex: ${raw.titlePrefix}`) }
    }
  }
  if (raw.slack !== undefined) {
    if (!isPlainObject(raw.slack)) problems.push(`"slack" must be an object with a "channel", got ${describeType(raw.slack)}`)
    else if (typeof raw.slack.channel !== 'string' || !raw.slack.channel) {
      problems.push('"slack.channel" is required (a channel ID like C0123ABC)')
    }
  }
  if (raw.labels !== undefined) {
    if (!isPlainObject(raw.labels)) problems.push(`"labels" must be an object, got ${describeType(raw.labels)}`)
    else {
      for (const [name, value] of Object.entries(raw.labels)) {
        if (typeof value !== 'string' || !value) problems.push(`"labels.${name}" must be a non-empty string, got ${describeType(value)}`)
      }
    }
  }
  if (raw.depth !== undefined && raw.depth !== 'standard') {
    problems.push(raw.depth === 'deep'
      ? 'depth "deep" is not implemented in v1 — see "Depth 2 upgrade path" in the spec'
      : `unknown depth "${raw.depth}" (expected "standard")`)
  }
  if (problems.length) throw new Error(`Invalid ${CONFIG_FILENAME}:\n${problems.map((p) => `  - ${p}`).join('\n')}`)

  assertNoSecrets(raw)

  const config = {
    ...raw,
    labels: { requested: 'review-requested', inProgress: 'review-in-progress', error: 'review-error', ...(raw.labels || {}) },
    slack: {
      ...raw.slack,
      emoji: { inReview: 'eyes', approved: 'white_check_mark', changesRequested: 'x', ...(raw.slack.emoji || {}) },
    },
    authorMap: raw.authorMap || {},
    maxPerCycle: raw.maxPerCycle ?? 3,
    maxDiffLines: raw.maxDiffLines ?? 3000,
    depth: raw.depth ?? 'standard',
    telemetry: raw.telemetry ?? false,
    clonesDir: raw.clonesDir || join(homedir(), '.cache', 'pr-review-bot', 'clones'),
  }
  if (!('model' in raw)) delete config.model
  return config
}

export function loadConfig(dir, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const raw = JSON.parse(readFile(join(dir, CONFIG_FILENAME)))
  const config = validateConfig(raw)
  config.criteria = readFile(join(dir, CRITERIA_FILENAME))
  config.configDir = dir
  return config
}
