import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const CONFIG_FILENAME = 'team.json'
export const CRITERIA_FILENAME = 'review-criteria.md'

// Matched against the key with separators removed, so api_key / api-key /
// apiKey all normalize to the same spelling.
const SECRET_KEY_RE = /token|secret|password|privatekey|apikey|credential/
// "pat" needs token boundaries: bare substring matching would flag path,
// patch, and titlePattern.
const KEY_TOKEN_SPLIT = /[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])/
const SECRET_KEY_TOKENS = new Set(['pat', 'pats'])
// Unanchored: credentials get pasted mid-string ("Bearer ghs_…", "use ghp_… to
// test") or with leading whitespace. \b keeps "sk-" from matching "task-".
const SECRET_VALUE_RE = /\b(xox[baprs]-|ghp_|gho_|ghs_|ghu_|github_pat_|sk-)|-----BEGIN/

function isSecretShapedKey(key) {
  if (SECRET_KEY_RE.test(key.toLowerCase().replace(/[^a-z]/g, ''))) return true
  return key.split(KEY_TOKEN_SPLIT).some((part) => SECRET_KEY_TOKENS.has(part.toLowerCase()))
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
