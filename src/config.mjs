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
    // Slack app-level tokens (Socket Mode) are xapp-, which xox[baprs]-
    // deliberately excludes — and this tool IS a Slack integration, so it is
    // the single credential its users are most likely to have on hand while
    // editing team.json. Nothing else looked for it.
    'xapp-[A-Za-z0-9-]{10,}',
    // GitHub: ghp_/gho_/ghs_/ghu_/ghr_ plus 36 alphanumerics; fine-grained PATs
    // are github_pat_ plus a much longer alphanumeric/underscore body. These
    // bodies really are alphanumeric — GitHub's alphabet has no "-" or "_" —
    // so widening them the way the sk- family needs would only cost accuracy.
    'gh[posur]_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    // Model-provider keys are BASE64URL: "-" and "_" are ordinary characters
    // inside the body, not separators between words. Demanding one long
    // alphanumeric run therefore missed about a third of real keys — a
    // sk-ant-api03- key's longest unbroken run is routinely 13 characters.
    // The two vendor prefixes below are unmistakable, so they only need a body.
    'sk-ant-api\\d{2}-[A-Za-z0-9_-]{20,}',
    'sk-proj-[A-Za-z0-9_-]{20,}',
    // Classic sk- keys, and anything else that reaches a 20-run.
    'sk-(?:[A-Za-z0-9_]+-)*[A-Za-z0-9_]{20,}',
    // Google (Maps, Gemini, and every other Google API): AIza + 35 base64url.
    'AIza[A-Za-z0-9_-]{30,}',
    // Groq, xAI, HuggingFace — all long unbroken alphanumeric bodies.
    'gsk_[A-Za-z0-9]{20,}',
    'xai-[A-Za-z0-9]{20,}',
    'hf_' + '[A-Za-z0-9]{20,}',
    // AWS key ids are SCREAMING_SNAKE-shaped, which is exactly what the
    // env-var-name exemption below used to wave through: AKIAIOSFODNN7EXAMPLE
    // reads as a variable name and is a live credential.
    'A(?:KIA|SIA|ROA|IDA|NPA|GPA|IPA|PKA)[0-9A-Z]{16}',
    // Backstop for prefixes no one has published yet. What marks random key
    // material is a case transition INSIDE one unbroken run — "x7Kd", "9fPq2",
    // "Lm4Nb" — which is something kebab-case names never do, because their
    // word boundaries are the separators. The old test was "a capital and a
    // digit anywhere in 32 characters", and ordinary values met it: an ops
    // path (/opt/sk-review-bot-clones-CI-2026-shard1) and a repo name
    // (acme/sk-learn-Model-2024-experiments-archive) each hard-failed startup
    // with a message accusing the team of committing a credential. Capitalised
    // words ("Model") and acronyms ("CI") carry no in-run transition; a
    // base64url body of this length carries one with near-certainty.
    'sk-(?=[A-Za-z0-9_-]{32,})(?=[A-Za-z0-9_-]*\\d)(?=[A-Za-z0-9_-]*[a-z][A-Za-z0-9]*[A-Z])[A-Za-z0-9_-]{32,}',
    '-----BEGIN',
  ].join('|')
)

// A key can only NAME a secret; the value is the secret. Key-based detection
// stays, because it is the only thing that catches a credential in a format
// nothing recognises — a hex blob, a bare base64 string — but it now needs a
// value capable of BEING one before it fires. Without that gate, "maxTokens"
// hard-failed startup with a message accusing the team of committing a
// credential, and so did apiKeyEnvVar / credentialHelper / secretsManagerPath,
// which name where a secret lives rather than holding one.
// A leading "/", "~" or "." is a location, not key material. Kept as an
// exemption rather than folded into the run test below because machine-made
// paths really do carry long random segments (/var/folders/T/AbCd19…/clones).
const PATH_LIKE_RE = /^[~.]|^\/|^[A-Za-z]:\\/
// Where a human name puts its word boundaries. Random material does not have
// word boundaries, so the RUNS between separators are what get measured.
const RUN_RE = /[A-Za-z0-9]+/g

function looksLikeSecretMaterial(value) {
  // A budget is a number, and no number is a credential.
  if (typeof value !== 'string') return false
  const v = value.trim()
  // A recognised credential shape is a credential whatever else it resembles.
  // This is the whole of the old env-var-name exemption's undoing: "it looks
  // like ANTHROPIC_API_KEY" exempted the VALUE under every key including
  // apiKey, and an AWS access key id is shaped precisely like a variable name.
  // Being all-caps is not evidence of innocence; matching no known credential
  // shape is, and that is now the only version of the exemption left.
  if (SECRET_VALUE_RE.test(v)) return true
  if (PATH_LIKE_RE.test(v)) return false
  // Randomness shows up as an unbroken RUN, not as a capital and a digit
  // sitting somewhere in the same string. Counting across separators read
  // "Claude-Sonnet-4-5-20250929" (an ordinary capitalised model id) and
  // "projects/123456/secrets/PR_BOT_TOKEN" (the canonical GCP Secret Manager
  // path, on a key whose entire purpose is to name where a secret lives) as
  // key material and hard-failed startup accusing the team of committing a
  // credential. 32 unbroken characters is a blob — a hex digest, a bare base64
  // string, the case key-based detection exists for; 16 carrying both a
  // capital and a digit is random rather than a word. "ANTHROPIC_API_KEY",
  // "osxkeychain" and "cl100k" are neither.
  return (v.match(RUN_RE) || []).some(
    (run) => run.length >= 32 || (run.length >= 16 && /[A-Z]/.test(run) && /\d/.test(run))
  )
}

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
    if (isSecretShapedKey(key) && looksLikeSecretMaterial(value)) {
      throw new Error(`Secret-shaped key "${here}" in ${CONFIG_FILENAME} carries what looks like a credential. Secrets belong in ~/.config/pr-review-bot/.env, never in config.`)
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
      emoji: { inReview: 'eyes', approved: 'white_check_mark', changesRequested: 'x', error: 'warning', ...(raw.slack.emoji || {}) },
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
