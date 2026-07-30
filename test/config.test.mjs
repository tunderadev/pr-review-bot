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

test('validateConfig reports every problem at once', () => {
  assert.throws(
    () => validateConfig({ owner: 'x' }),
    (e) => e.message.includes('team') && e.message.includes('repos') && e.message.includes('titlePrefix')
  )
})

test('validateConfig rejects an uncompilable titlePrefix', () => {
  assert.throws(() => validateConfig({ ...VALID, titlePrefix: '^[PLAT' }), /titlePrefix/)
})

test('validateConfig rejects unimplemented depth', () => {
  assert.throws(() => validateConfig({ ...VALID, depth: 'deep' }), /not implemented in v1/)
})

test('assertNoSecrets rejects token-shaped values and secret-shaped keys', () => {
  assert.throws(() => assertNoSecrets({ ...VALID, slackBotToken: 'xoxb-' + '1-2-abc' }), /slackBotToken/)
  assert.throws(() => assertNoSecrets({ ...VALID, nested: { deep: 'ghp_aaaaaaaaaaaa' } }), /nested\.deep/)
  assert.doesNotThrow(() => assertNoSecrets(VALID))
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
