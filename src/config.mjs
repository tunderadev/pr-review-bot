import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const CONFIG_FILENAME = 'team.json'
export const CRITERIA_FILENAME = 'review-criteria.md'

const SECRET_KEY_RE = /token|secret|password|privatekey|apikey/i
const SECRET_VALUE_RE = /^(xox[baprs]-|ghp_|gho_|ghs_|ghu_|github_pat_|sk-|-----BEGIN)/

export function resolveConfigDir({ flag, env, cwd = process.cwd(), home = homedir(), exists = existsSync }) {
  const candidates = [
    flag,
    env,
    join(cwd, '.claude', 'pr-review'),
    join(home, '.config', 'pr-review-bot', 'default'),
  ].filter(Boolean)
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
    if (SECRET_KEY_RE.test(key)) {
      throw new Error(`Secret-shaped key "${here}" in ${CONFIG_FILENAME}. Secrets belong in ~/.config/pr-review-bot/.env, never in config.`)
    }
    if (typeof value === 'string' && SECRET_VALUE_RE.test(value)) {
      throw new Error(`Value at "${here}" looks like a credential. Secrets belong in ~/.config/pr-review-bot/.env, never in config.`)
    }
  }
}

export function validateConfig(raw) {
  const problems = []
  for (const key of ['team', 'owner', 'repos', 'titlePrefix', 'slack']) {
    if (raw[key] === undefined) problems.push(`missing required key "${key}"`)
  }
  if (raw.repos !== undefined && (!Array.isArray(raw.repos) || raw.repos.length === 0)) {
    problems.push('"repos" must be a non-empty array of "owner/name" strings')
  }
  if (typeof raw.titlePrefix === 'string') {
    try { new RegExp(raw.titlePrefix) } catch { problems.push(`"titlePrefix" is not a valid regex: ${raw.titlePrefix}`) }
  }
  if (raw.slack && !raw.slack.channel) problems.push('"slack.channel" is required (a channel ID like C0123ABC)')
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
