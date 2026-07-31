import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfigDir, validateConfig, assertNoSecrets, loadConfig, CONFIG_FILENAME, CRITERIA_FILENAME } from '../src/config.mjs'

const VALID = {
  team: 'platform',
  owner: 'octocat',
  repos: ['octocat/storefront'],
  titlePrefix: '^\\[PLAT\\]',
  slack: { channel: 'C0123ABC' },
}

test('resolveConfigDir honors precedence: flag > env > cwd > home', () => {
  const present = new Set([
    `/from-flag/${CONFIG_FILENAME}`,
    `/from-env/${CONFIG_FILENAME}`,
    `/cwd/.claude/pr-review/${CONFIG_FILENAME}`,
    `/home/.config/pr-review-bot/default/${CONFIG_FILENAME}`,
  ])
  const exists = (p) => present.has(p)
  const args = { env: '/from-env', cwd: '/cwd', home: '/home', exists }

  assert.equal(resolveConfigDir({ ...args, flag: '/from-flag' }), '/from-flag')
  assert.equal(resolveConfigDir({ ...args }), '/from-env')
  assert.equal(resolveConfigDir({ ...args, env: undefined }), '/cwd/.claude/pr-review')
  assert.equal(resolveConfigDir({ ...args, env: undefined, cwd: '/nope' }), '/home/.config/pr-review-bot/default')
  // Only the implicit cwd and home tiers are a search path; see the next test.
})

test('an explicitly supplied config dir without team.json is a hard error, not a fallthrough', () => {
  // Falling through would silently run the bot under another team's profile:
  // different repos, different criteria, different Slack channel — and it
  // would post real reviews under it.
  const present = new Set([
    `/cwd/.claude/pr-review/${CONFIG_FILENAME}`,
    `/home/.config/pr-review-bot/default/${CONFIG_FILENAME}`,
  ])
  const args = { cwd: '/cwd', home: '/home', exists: (p) => present.has(p) }

  assert.throws(() => resolveConfigDir({ ...args, flag: '/typo-dir' }), (e) => {
    assert.match(e.message, /\/typo-dir/, 'the error must name the directory given')
    assert.match(e.message, /--config/)
    return true
  })
  assert.throws(() => resolveConfigDir({ ...args, env: '/typo-env' }), (e) => {
    assert.match(e.message, /\/typo-env/)
    assert.match(e.message, /PR_REVIEW_CONFIG_DIR/)
    return true
  })
  // A bad flag is fatal even when the env dir would have resolved.
  const withEnv = new Set([...present, `/from-env/${CONFIG_FILENAME}`])
  assert.throws(() => resolveConfigDir({ ...args, exists: (p) => withEnv.has(p), flag: '/typo-dir', env: '/from-env' }), /\/typo-dir/)
})

test('resolveConfigDir error names every path it searched', () => {
  assert.throws(
    () => resolveConfigDir({ cwd: '/a', home: '/b', exists: () => false }),
    (e) => e.message.includes('/a/.claude/pr-review') && e.message.includes('/b/.config/pr-review-bot/default')
  )
})

test('validateConfig applies defaults without inventing a model', () => {
  const c = validateConfig(VALID)
  assert.equal(c.maxPerCycle, 3)
  assert.equal(c.maxDiffLines, 3000)
  assert.equal(c.depth, 'standard')
  assert.equal(c.telemetry, false)
  assert.equal(c.labels.requested, 'review-requested')
  assert.equal(c.labels.inProgress, 'review-in-progress')
  assert.equal(c.labels.error, 'review-error')
  assert.equal(c.slack.emoji.approved, 'white_check_mark')
  assert.equal(c.slack.emoji.changesRequested, 'x')
  assert.equal(c.slack.emoji.inReview, 'eyes')
  // Without a default, an errored review renders `undefined` as its reaction
  // and the Slack call fails — silently, since every Slack failure is
  // non-blocking by design.
  assert.equal(c.slack.emoji.error, 'warning')
  assert.deepEqual(c.authorMap, {})
  assert.ok(!('model' in c), 'model must not be defaulted')
})

test('a config that pins a model is rejected, not silently ignored', () => {
  // It cannot be honoured — headless children inherit the operator's own saved
  // CLI default and are never pinned — so accepting the key and ignoring it is
  // the worst answer available: the operator believes it took effect.
  assert.throws(
    () => validateConfig({ ...VALID, model: 'claude-opus-4-1' }),
    (e) => /"model" is not supported/.test(e.message) && /CLI default/.test(e.message),
    'a pinned model must be refused, with a message that explains why'
  )
  assert.throws(() => validateConfig({ ...VALID, model: null }), /"model" is not supported/, 'the key itself is the error, whatever it holds')
  assert.doesNotThrow(() => validateConfig(VALID), 'a config without the key still validates')
  // A neighbouring key that merely contains the word is not the pin.
  assert.doesNotThrow(() => validateConfig({ ...VALID, tokenizerModel: 'Claude-Sonnet-4-5-20250929' }))
})

test('validateConfig requires team', () => {
  const { team, ...withoutTeam } = VALID
  assert.throws(() => validateConfig(withoutTeam), /missing required key "team"/)
})

test('validateConfig reports every problem at once', () => {
  assert.throws(
    () => validateConfig({ owner: 'x' }),
    (e) => e.message.includes('missing required key "repos"') && e.message.includes('missing required key "titlePrefix"')
  )
})

test('validateConfig rejects an uncompilable titlePrefix', () => {
  assert.throws(() => validateConfig({ ...VALID, titlePrefix: '^[PLAT' }), /titlePrefix/)
})

test('validateConfig rejects unimplemented depth', () => {
  assert.throws(() => validateConfig({ ...VALID, depth: 'deep' }), /not implemented in v1/)
})

test('validateConfig rejects a non-string titlePrefix rather than stringifying it', () => {
  // null compiles to /null/ and selects nothing; {} compiles to
  // /[object Object]/ and matches nearly every title — both silently.
  for (const titlePrefix of [null, { a: 1 }, 42, ['^\\[PLAT\\]'], true]) {
    assert.throws(
      () => validateConfig({ ...VALID, titlePrefix }),
      /"titlePrefix" must be a string/,
      `accepted titlePrefix ${JSON.stringify(titlePrefix)}`
    )
  }
})

test('validateConfig requires slack to be an object carrying a string channel', () => {
  for (const slack of [null, false, 0, 'C0123ABC', ['C0123ABC']]) {
    assert.throws(
      () => validateConfig({ ...VALID, slack }),
      /Invalid team\.json[\s\S]*"slack"/,
      `accepted slack ${JSON.stringify(slack)}`
    )
  }
  // Every Slack failure is non-blocking by design, so a missing channel would
  // never surface at runtime — the Slack half would just never work.
  assert.throws(() => validateConfig({ ...VALID, slack: {} }), /"slack\.channel"/)
  assert.throws(() => validateConfig({ ...VALID, slack: { channel: 123 } }), /"slack\.channel"/)
  assert.throws(() => validateConfig({ ...VALID, slack: { channel: '' } }), /"slack\.channel"/)
})

test('validateConfig rejects non-string label overrides', () => {
  assert.throws(() => validateConfig({ ...VALID, labels: { requested: null } }), /"labels\.requested"/)
  assert.throws(() => validateConfig({ ...VALID, labels: { error: 42 } }), /"labels\.error"/)
  assert.throws(() => validateConfig({ ...VALID, labels: 'review-requested' }), /"labels" must be an object/)
})

test('validateConfig reports type problems together, not one per run', () => {
  assert.throws(
    () => validateConfig({ ...VALID, titlePrefix: null, slack: null }),
    (e) => e.message.includes('"titlePrefix" must be a string') && e.message.includes('"slack" must be an object')
  )
})

test('assertNoSecrets rejects token-shaped values and secret-shaped keys', () => {
  assert.throws(() => assertNoSecrets({ ...VALID, slackBotToken: 'xoxb-' + '1-2-abcdefghijklmnop' }), /slackBotToken/)
  assert.throws(() => assertNoSecrets({ ...VALID, nested: { deep: 'ghp_0123456789abcdefghijklmnopqrstuvwx' } }), /nested\.deep/)
  assert.doesNotThrow(() => assertNoSecrets(VALID))
})

test('assertNoSecrets finds a credential anywhere in the value, not only at position 0', () => {
  // team.json is committed to a repo the team owns: anything that slips this
  // guard becomes a credential in git history.
  const leaks = [
    'Bearer ghs_0123456789abcdefghijklmnopqrstuvwx',
    '  ghp_0123456789abcdefghijklmnopqrstuvwx',
    'use ghp_0123456789abcdefghijklmnopqrstuvwx to test',
    'export SLACK=xoxb-1-2-abcdefghijklmnop',
    'run with sk-abcdef0123456789abcdef0123456789',
    'github_pat_11ABCDEFG0abcdefghijklmnop',
    'key is\n-----BEGIN RSA PRIVATE KEY-----',
  ]
  for (const value of leaks) {
    assert.throws(() => assertNoSecrets({ ...VALID, note: value }), /"note"/, `leaked ${JSON.stringify(value)}`)
  }
})

// Anthropic and OpenAI project keys are base64url: the body carries "-" and "_"
// as ordinary characters, so it is NOT one long alphanumeric run. Requiring one
// let roughly a third of real keys through — including every key below, whose
// longest unbroken alphanumeric stretch is 13 to 19 characters.
const REAL_PROVIDER_KEYS = [
  'sk-ant-api03-x7Kd_9fPq2-Lm4Nb_8vCx1-Ze6Yt_3hGw5-Ju0Rs_7dAq2-Bn9Mk_4lZp1AA',
  'sk-ant-api03-Qw3_Er4-Ty5_Ui6-Op7_As8-Df9_Gh0-Jk1_Lz2-Xc3_Vb4-Nm5_Qa6-Ws7_Ed8-Rf9_Tg0-Yh1_Uj2-Ik3_Ol4AA',
  'sk-proj-Tf3-Lm9_Qa2Xv7Bn-Zk4Rd8_Wp1Ye6-Hs5Ct0Ju3-Nx7Vg2Mb9_Lq4Kz8Aw1',
  'sk-proj-9dK_2mQ-4vX_7bN-1zR_8cT-5jH_0pL-3wS_6yF-2gD_9kM-7nB_4xV1',
]

test('a base64url provider key is a credential even with no long alphanumeric run', () => {
  for (const key of REAL_PROVIDER_KEYS) {
    const longestRun = Math.max(...key.split(/[^A-Za-z0-9]/).map((s) => s.length))
    assert.ok(longestRun < 20, `fixture ${key} has a ${longestRun}-char run — not representative of a base64url key`)
    assert.throws(() => assertNoSecrets({ ...VALID, note: key }), /"note"/, `leaked ${key}`)
    assert.throws(() => assertNoSecrets({ ...VALID, note: `ANTHROPIC_API_KEY=${key}` }), /"note"/, `leaked ${key} mid-string`)
  }
})

// A fixed seed, so this is a deterministic sweep and not a lottery: the same
// 800 keys every run. Hand-picked fixtures hid this bug once already — the old
// one was all-alphanumeric, which no real project key is.
function makeRng(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

test('every synthetic provider key is caught, not two thirds of them', () => {
  const rng = makeRng(20260731)
  let checked = 0
  for (const [prefix, length] of [['sk-ant-api03-', 95], ['sk-proj-', 48]]) {
    for (let i = 0; i < 400; i++) {
      let body = ''
      for (let c = 0; c < length; c++) body += BASE64URL[Math.floor(rng() * 64)]
      const key = prefix + body
      assert.throws(() => assertNoSecrets({ ...VALID, note: key }), /"note"/, `leaked ${key}`)
      checked++
    }
  }
  assert.equal(checked, 800)
})

// The prefixes a user of THIS tool actually has on hand. xapp- is first
// deliberately: the tool is a Slack integration, and xox[baprs]- excludes the
// app-level token, so the one credential most likely to be pasted into
// team.json was the one credential nothing looked for.
const PROVIDER_LEAKS = [
  ['Slack app-level', 'xapp-1-A05J8QK3LMN-6035112233445-9f2c1d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f'],
  ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['Google API key', 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'],
  ['Groq', 'gsk_1a2B3c4D5e6F7g8H9i0JklMnOpQrStUvWxYz1234567890abcd'],
  ['xAI', 'xai-9fK2mQ4vX7bN1zR8cT5jH0pL3wS6yF2gD9kM7nB4xV1aZ'],
  ['HuggingFace', 'hf_' + 'KjHgFdSaPoIuYtReWqZxCvBnMlKjHgFdSa'],
]

test('every provider prefix a user of this tool might paste is a credential', () => {
  for (const [vendor, value] of PROVIDER_LEAKS) {
    assert.throws(() => assertNoSecrets({ ...VALID, note: value }), /"note"/, `missed a ${vendor} token`)
    assert.throws(
      () => assertNoSecrets({ ...VALID, note: `SLACK_APP_TOKEN=${value}` }),
      /"note"/,
      `missed a ${vendor} token mid-string`
    )
  }
})

test('an all-caps value is exempt only while it is a NAME, never when it is a credential', () => {
  // "It looks like an env var name" used to exempt the value outright, under
  // any key at all — which is the exact shape of an AWS access key id and of
  // any SCREAMING_SNAKE credential. Being all-caps is not evidence of
  // innocence; not matching a credential shape is.
  assert.throws(() => assertNoSecrets({ ...VALID, apiKey: 'AKIAIOSFODNN7EXAMPLE' }), /apiKey/, 'missed an AWS access key id under apiKey')
  // No vendor prefix at all: nothing but the key and the shape of the value
  // marks this one, so it pins the exemption itself rather than a pattern.
  assert.throws(() => assertNoSecrets({ ...VALID, apiKey: 'A1B2C3D4E5F6G7H8I9J0K1L2' }), /apiKey/, 'missed an unprefixed SCREAMING_SNAKE credential under apiKey')
  // A key that still only names where the secret lives stays legal.
  for (const name of ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    assert.doesNotThrow(() => assertNoSecrets({ ...VALID, apiKeyEnvVar: name }), `rejected env var name ${name}`)
  }
})

test('a path, a repo name and a model id are not credentials', () => {
  // Every one of these hard-fails startup with a message accusing the team of
  // committing a credential. secretsManagerPath is the canonical GCP Secret
  // Manager path, on a key whose entire purpose is to NAME where a secret
  // lives; the model ids are ordinary capitalised model ids; the last two are
  // an ops path and a repo name that merely reach 32 kebab-case characters.
  const ordinary = [
    ['secretsManagerPath', 'projects/123456/secrets/PR_BOT_TOKEN'],
    ['tokenizerModel', 'Claude-Sonnet-4-5-20250929'],
    ['tokenizerModel', 'GPT-4o-2024-08-06'],
    ['clonesDir', '/opt/sk-review-bot-clones-CI-2026-shard1'],
    ['repos', ['acme/sk-learn-Model-2024-experiments-archive']],
  ]
  for (const [key, value] of ordinary) {
    assert.doesNotThrow(
      () => assertNoSecrets({ ...VALID, [key]: value }),
      `rejected ordinary config ${key}=${JSON.stringify(value)}`
    )
  }
  // Narrowing these must not disarm the same keys against real material.
  assert.throws(() => assertNoSecrets({ ...VALID, secretsManagerPath: '8f14e45fceea167a5a36dedd4bea25436a1f7e2c' }), /secretsManagerPath/)
  assert.throws(() => assertNoSecrets({ ...VALID, clonesDir: '/opt/clones/xoxb-1-2-abcdefghijklmnop' }), /clonesDir/)
  assert.throws(() => assertNoSecrets({ ...VALID, repos: ['acme/sk-proj-9dK_2mQ-4vX_7bN-1zR_8cT-5jH_0pL-3wS'] }), /repos\.0/)
})

test('assertNoSecrets covers separator and camelCase spellings of secret keys', () => {
  // The value is a 40-char hex blob: no vendor prefix, so nothing but the KEY
  // marks it as a credential. That is the case key-based detection exists for.
  const opaque = '8f14e45fceea167a5a36dedd4bea25436a1f7e2c'
  const keys = ['api_key', 'api-key', 'apiKey', 'API_KEY', 'private_key', 'private-key', 'privateKey', 'githubPat', 'github_pat', 'pat', 'credential', 'credentials']
  for (const key of keys) {
    assert.throws(() => assertNoSecrets({ ...VALID, [key]: opaque }), new RegExp(key), `accepted secret-shaped key "${key}"`)
  }
})

test('a key that names a secret is not a key that contains one', () => {
  // Every one of these hard-failed startup with a message accusing the team of
  // committing a credential. maxTokens in an LLM review bot's team.json is
  // about as ordinary as a config key gets, and the last three name WHERE a
  // secret lives rather than holding one.
  const ordinary = [
    ['maxTokens', 4096],
    ['tokenBudget', 100000],
    ['tokenLimit', 8000],
    ['maxOutputTokens', 32000],
    ['tokenizerModel', 'cl100k'],
    ['apiKeyEnvVar', 'ANTHROPIC_API_KEY'],
    ['credentialHelper', 'osxkeychain'],
    ['secretsManagerPath', '/run/secrets/gh-app'],
  ]
  for (const [key, value] of ordinary) {
    assert.doesNotThrow(
      () => assertNoSecrets({ ...VALID, [key]: value }),
      `rejected ordinary config ${key}=${JSON.stringify(value)}`
    )
  }
  // Same keys, real credentials: narrowing the key rule must not disarm it.
  assert.throws(() => assertNoSecrets({ ...VALID, tokenBudget: '8f14e45fceea167a5a36dedd4bea25436a1f7e2c' }), /tokenBudget/)
  assert.throws(() => assertNoSecrets({ ...VALID, apiKeyEnvVar: REAL_PROVIDER_KEYS[0] }), /apiKeyEnvVar/)
})

test('assertNoSecrets does not flag ordinary config values', () => {
  // "task-runner" contains the literal "sk-"; "titlePattern"/"path" contain "pat".
  assert.doesNotThrow(() =>
    assertNoSecrets({ ...VALID, repos: ['acme/task-runner'], clonesDir: '/home/me/.cache/path', titlePattern: 'x', path: '/tmp' })
  )
})

test('a bare credential prefix in an ordinary value is not a credential', () => {
  // A prefix alone is not a leak. Rejecting one hard-fails startup on day one
  // with a message accusing the team of committing a secret — over a SvelteKit
  // repo name or a cache directory.
  const ordinary = [
    ['repos', ['acme/sk-tools']],
    ['clonesDir', '/home/me/sk-clones'],
    ['clonesDir', '/home/me/sk-cache-of-review-clones'],
    ['note', 'see the sk- prefixed repos'],
    ['note', 'gho_ is the OAuth prefix'],
  ]
  for (const [key, value] of ordinary) {
    assert.doesNotThrow(
      () => assertNoSecrets({ ...VALID, [key]: value }),
      `rejected ordinary value ${key}=${JSON.stringify(value)}`
    )
  }
})

test('ordinary keys that merely contain "pat" are not secret-shaped', () => {
  for (const key of ['PAT_DIRS', 'pat_dirs', 'patStrategy', 'pats', 'patch', 'path']) {
    assert.doesNotThrow(() => assertNoSecrets({ ...VALID, [key]: 'x' }), `rejected ordinary key "${key}"`)
  }
})

test('assertNoSecrets catches a credential glued to a preceding word character', () => {
  // A word boundary before the prefix cannot fire after a word character, so
  // exactly the shapes a .env dump produces would have slipped through.
  const leaks = ['SLACK_TOKEN_xoxb-1-2-abcdef', 'prefix_ghp_0123456789abcdefghij', 'GITHUB_TOKEN=ghs_0123456789abcdefghij']
  for (const value of leaks) {
    assert.throws(() => assertNoSecrets({ ...VALID, note: value }), /"note"/, `leaked ${JSON.stringify(value)}`)
  }
})

test('loadConfig reads files, validates, and attaches criteria and configDir', () => {
  const mockReadFile = (path) => {
    if (path.endsWith(CONFIG_FILENAME)) return JSON.stringify(VALID)
    if (path.endsWith(CRITERIA_FILENAME)) return '# Review Criteria\n\nCheck for X and Y'
    throw new Error(`Unexpected path: ${path}`)
  }
  const config = loadConfig('/config/dir', { readFile: mockReadFile })
  assert.equal(config.team, 'platform')
  assert.equal(config.owner, 'octocat')
  assert.equal(config.criteria, '# Review Criteria\n\nCheck for X and Y')
  assert.equal(config.configDir, '/config/dir')
})
