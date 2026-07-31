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
  assert.deepEqual(c.authorMap, {})
  assert.ok(!('model' in c), 'model must not be defaulted')
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
  assert.throws(() => assertNoSecrets({ ...VALID, slackBotToken: 'xoxb-' + '1-2-abc' }), /slackBotToken/)
  assert.throws(() => assertNoSecrets({ ...VALID, nested: { deep: 'ghp_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc' } }), /nested\.deep/)
  assert.doesNotThrow(() => assertNoSecrets(VALID))
})

test('assertNoSecrets finds a credential anywhere in the value, not only at position 0', () => {
  // team.json is committed to a repo the team owns: anything that slips this
  // guard becomes a credential in git history.
  const leaks = [
    'Bearer ghs_0123456789abcdefghij',
    '  ghp_0123456789abcdefghij',
    'use ghp_0123456789abcdefghij to test',
    'export SLACK=xoxb-1-2-abcdef',
    'run with sk-abcdef0123456789abcdef0123456789',
    'run with sk-proj-abcdef0123456789abcdef0123456789',
    'github_pat_11ABCDEFG0abcdefghijklmnop',
    'key is\n-----BEGIN RSA PRIVATE KEY-----',
  ]
  for (const value of leaks) {
    assert.throws(() => assertNoSecrets({ ...VALID, note: value }), /"note"/, `leaked ${JSON.stringify(value)}`)
  }
})

test('assertNoSecrets covers separator and camelCase spellings of secret keys', () => {
  const keys = ['api_key', 'api-key', 'apiKey', 'API_KEY', 'private_key', 'private-key', 'privateKey', 'githubPat', 'github_pat', 'pat', 'credential', 'credentials']
  for (const key of keys) {
    assert.throws(() => assertNoSecrets({ ...VALID, [key]: 'anything' }), new RegExp(key), `accepted secret-shaped key "${key}"`)
  }
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
