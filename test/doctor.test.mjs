import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDoctor } from '../src/doctor.mjs'

const config = {
  repos: ['o/r'],
  labels: { requested: 'review-requested', inProgress: 'review-in-progress', error: 'review-error' },
  slack: { channel: 'C1', emoji: { inReview: 'eyes', approved: 'white_check_mark', changesRequested: 'x' } },
  authorMap: { octocat: 'U1' },
  criteria: 'be careful',
  telemetry: false,
}

// What a healthy GitHub App installation looks like to the doctor. The probe
// reports facts nobody can infer from a token string: how the token was
// obtained, who it authenticates as, and what the installation was granted.
const APP_AUTH = {
  tokenSource: 'app-installation',
  login: 'plat-reviewer[bot]',
  permissions: { pull_requests: 'write', issues: 'write', contents: 'read', metadata: 'read' },
}

// The brief's fixture had no `addReaction`, so the happy run called undefined,
// the TypeError landed in the reactions catch, and "all green yields ok:true"
// asserted the opposite of what it was written to prove. The stub is the fix,
// not the implementation: doctor MUST exercise add and remove, because
// reactions:write is a separate scope and reconciliation is load-bearing.
// Injected into every case, the brief's six included: doctor's default probe
// shells out to the real `claude`, and a suite that runs whatever happens to be
// installed on the machine is testing the machine, not the code.
const CLAUDE_CLI = async () => ({ version: '2.0.14 (Claude Code)', path: '/usr/local/bin/claude' })

const happy = {
  github: { listOpenPrs: async () => [], ensureLabel: async () => ({}) },
  slack: { postMessage: async () => ({ ts: '1' }), addReaction: async () => ({}), removeReaction: async () => ({}) },
  appAuth: async () => APP_AUTH,
  claudeCli: CLAUDE_CLI,
}

const find = (r, name) => r.checks.find((c) => c.name === name)
const failedNames = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name)

// Records every outbound call, so a test can assert not only that a check
// reported something but that the work behind it actually happened — and, for
// the reaction check, that what doctor added it also took back off.
function deps(over = {}) {
  const calls = { labels: [], posts: [], reactions: [], repos: [] }
  const github = {
    listOpenPrs: async (repo) => { calls.repos.push(repo); return [] },
    ensureLabel: async (repo, name, color, description) => { calls.labels.push({ repo, name, color, description }); return {} },
    ...over.github,
  }
  const slack = {
    postMessage: async (args) => { calls.posts.push(args); return { ts: '111.222' } },
    addReaction: async ({ name, ts }) => { calls.reactions.push(['add', name, ts]); return {} },
    removeReaction: async ({ name, ts }) => { calls.reactions.push(['remove', name, ts]); return {} },
    ...over.slack,
  }
  return {
    calls,
    args: {
      config: over.config ?? config,
      configDir: over.configDir ?? '/cfg',
      env: over.env ?? {},
      gitTracked: over.gitTracked ?? (() => false),
      appAuth: 'appAuth' in over ? over.appAuth : async () => APP_AUTH,
      claudeCli: over.claudeCli ?? CLAUDE_CLI,
      github,
      slack,
    },
  }
}

// ---------------------------------------------------------------------------
// The brief's six
// ---------------------------------------------------------------------------

test('reports subscription auth when no API key is present', async () => {
  const r = await runDoctor({ config, configDir: '/cfg', ...happy, env: {}, gitTracked: () => false })
  assert.match(find(r, 'claude auth mode').detail, /subscription/i)
  assert.equal(find(r, 'claude auth mode').ok, true)
})

test('warns loudly when ANTHROPIC_API_KEY would bill the API', async () => {
  const r = await runDoctor({ config, configDir: '/cfg', ...happy, env: { ANTHROPIC_API_KEY: 'sk-x' }, gitTracked: () => false })
  const check = find(r, 'claude auth mode')
  assert.equal(check.ok, false)
  assert.match(check.detail, /ANTHROPIC_API_KEY/)
  assert.equal(r.ok, false)
})

test('fails when a .env sits inside a git-tracked config dir', async () => {
  const r = await runDoctor({ config, configDir: '/cfg', ...happy, env: {}, gitTracked: (p) => p.endsWith('.env') })
  assert.equal(find(r, 'secrets not committed').ok, false)
  assert.equal(r.ok, false)
})

test('reports repo access failure per repo', async () => {
  const r = await runDoctor({
    config, configDir: '/cfg', env: {}, gitTracked: () => false, appAuth: happy.appAuth, claudeCli: CLAUDE_CLI,
    github: { listOpenPrs: async () => { throw new Error('Resource not accessible by integration') }, ensureLabel: async () => ({}) },
    slack: happy.slack,
  })
  assert.equal(find(r, 'repo access: o/r').ok, false)
  assert.match(find(r, 'repo access: o/r').detail, /not accessible/)
})

test('flags an empty authorMap as a warning, not a failure', async () => {
  const r = await runDoctor({ config: { ...config, authorMap: {} }, configDir: '/cfg', ...happy, env: {}, gitTracked: () => false })
  assert.equal(find(r, 'author mapping').ok, true)
  assert.match(find(r, 'author mapping').detail, /no authors mapped/i)
})

test('all green yields ok:true', async () => {
  const r = await runDoctor({ config, configDir: '/cfg', ...happy, env: {}, gitTracked: () => false })
  assert.equal(r.ok, true, `expected every check to pass, these failed: ${failedNames(r).join(', ')}`)
})

// ---------------------------------------------------------------------------
// The billing trap
// ---------------------------------------------------------------------------

test('every environment variable that takes a run off the subscription fails the auth check by name', async () => {
  for (const [name, value] of [
    ['ANTHROPIC_API_KEY', 'sk-ant-api03-xxx'],
    ['ANTHROPIC_AUTH_TOKEN', 'bearer-xxx'],
    ['ANTHROPIC_BASE_URL', 'https://gateway.internal'],
    ['CLAUDE_CODE_USE_BEDROCK', '1'],
    ['CLAUDE_CODE_USE_VERTEX', 'true'],
  ]) {
    const { args } = deps({ env: { [name]: value } })
    const r = await runDoctor(args)
    const check = find(r, 'claude auth mode')
    assert.equal(check.ok, false, `${name} must fail the auth-mode check`)
    assert.match(check.detail, new RegExp(name), `${name} must be named in the detail so the operator knows what to unset`)
    assert.equal(r.ok, false, `${name} must sink the whole run`)
  }
})

test('an off-valued or empty billing variable is not a false alarm', async () => {
  // `CLAUDE_CODE_USE_BEDROCK=0` is a JS-truthy string that means "disabled",
  // and an exported-but-empty ANTHROPIC_API_KEY authenticates nothing. Failing
  // on either teaches the operator to ignore this check, which is the one
  // check that must never be ignored.
  for (const env of [{ CLAUDE_CODE_USE_BEDROCK: '0' }, { CLAUDE_CODE_USE_VERTEX: 'false' }, { ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: '   ' }]) {
    const { args } = deps({ env })
    const r = await runDoctor(args)
    assert.equal(find(r, 'claude auth mode').ok, true, `${JSON.stringify(env)} must not be read as billing redirection`)
  }
})

test('the auth check names both offenders when both are set', async () => {
  const { args } = deps({ env: { ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_USE_BEDROCK: '1' } })
  const r = await runDoctor(args)
  const { detail } = find(r, 'claude auth mode')
  assert.match(detail, /ANTHROPIC_API_KEY/)
  assert.match(detail, /CLAUDE_CODE_USE_BEDROCK/)
})

// ---------------------------------------------------------------------------
// Is the `claude` binary there at all?
// ---------------------------------------------------------------------------

test('a resolved claude binary reports its version and refuses to claim you are logged in', async () => {
  const { args } = deps()
  const r = await runDoctor(args)
  const check = find(r, 'claude cli')
  assert.equal(check.ok, true)
  assert.match(check.detail, /2\.0\.14/, 'the version proves the binary ran, not merely that a file exists')
  assert.match(check.detail, /\/usr\/local\/bin\/claude/, 'name WHICH claude was found — the launchd PATH is the whole point')
  assert.match(check.detail, /does not prove you are logged in/i, 'presence is not authentication, and the detail must say so')
  assert.equal(r.ok, true)
})

test('a claude that is not on PATH is a hard failure that sinks the run', async () => {
  const { args } = deps({
    claudeCli: async () => { throw new Error('spawnSync /bin/sh ENOENT') },
  })
  const r = await runDoctor(args)
  const check = find(r, 'claude cli')
  assert.equal(check.ok, false)
  assert.match(check.detail, /claude/)
  assert.match(check.detail, /PATH/, 'name PATH: the binary is usually installed, just not visible to launchd or cron')
  assert.match(check.detail, /ENOENT/, 'keep the probe\'s own error, so a permissions failure is not misreported as a missing install')
  // Without it, every PR fails identically and each one leaves a sticky
  // review-error label for a human to clear. "All good" here is the exact
  // outcome this check exists to prevent.
  assert.equal(r.ok, false)
  assert.deepEqual(failedNames(r), ['claude cli'])
})

test('a probe that answers without a version is not a working binary', async () => {
  for (const claudeCli of [async () => null, async () => ({ path: '/usr/local/bin/claude' })]) {
    const r = await runDoctor(deps({ claudeCli }).args)
    assert.equal(find(r, 'claude cli').ok, false)
    assert.equal(r.ok, false)
  }
})

test('doctor spends no model quota to check the model runner', async () => {
  // A `claude -p` probe would draw on the same subscription that funds the
  // reviews. The check gets exactly one call, and the suite asserts the shape
  // of it rather than trusting the comment above it.
  const invocations = []
  const { args } = deps({ claudeCli: async (...a) => { invocations.push(a); return { version: '2.0.14' } } })
  await runDoctor(args)
  assert.equal(invocations.length, 1)
  assert.deepEqual(invocations[0], [], 'the probe takes no prompt, because there is no prompt to run')
})

// ---------------------------------------------------------------------------
// Can the App actually post a review?
// ---------------------------------------------------------------------------

test('a personal token is rejected before a review is ever paid for', async () => {
  const { args } = deps({
    appAuth: async () => ({ tokenSource: 'personal-token', login: 'octocat', permissions: { pull_requests: 'write', issues: 'write', contents: 'read' } }),
  })
  const r = await runDoctor(args)
  const check = find(r, 'github identity')
  assert.equal(check.ok, false)
  assert.match(check.detail, /octocat/, 'name the identity that is actually authenticated')
  assert.match(check.detail, /own pull request/i, 'name the 422 this prevents, since it only fires after the review is bought')
  assert.equal(r.ok, false)
})

test('a login that is not a bot fails identity even when the probe claims an installation', async () => {
  // Two independent signals, because either one alone is a single point of
  // failure: a wrapper that hardcodes tokenSource, or an app whose slug never
  // resolved and left "undefined[bot]"-shaped junk.
  const { args } = deps({ appAuth: async () => ({ ...APP_AUTH, login: 'octocat' }) })
  const r = await runDoctor(args)
  assert.equal(find(r, 'github identity').ok, false)
})

test('an installation identity passes and says what it does not prove', async () => {
  const { args } = deps()
  const r = await runDoctor(args)
  const check = find(r, 'github identity')
  assert.equal(check.ok, true)
  assert.match(check.detail, /plat-reviewer\[bot\]/)
})

test('pull_requests: read fails the review-capability check by name', async () => {
  const { args } = deps({ appAuth: async () => ({ ...APP_AUTH, permissions: { ...APP_AUTH.permissions, pull_requests: 'read' } }) })
  const r = await runDoctor(args)
  const check = find(r, 'review capability')
  assert.equal(check.ok, false)
  assert.match(check.detail, /pull_requests/)
  assert.match(check.detail, /write/)
  assert.equal(r.ok, false)
})

test('every permission the pipeline actually spends is checked, and each shortfall is named', async () => {
  for (const [permission, granted] of [['issues', 'read'], ['contents', undefined], ['pull_requests', undefined]]) {
    const permissions = { ...APP_AUTH.permissions }
    if (granted === undefined) delete permissions[permission]
    else permissions[permission] = granted
    const { args } = deps({ appAuth: async () => ({ ...APP_AUTH, permissions }) })
    const r = await runDoctor(args)
    const check = find(r, 'review capability')
    assert.equal(check.ok, false, `${permission}: ${granted ?? 'absent'} must fail`)
    assert.match(check.detail, new RegExp(permission))
  }
})

test('a granted installation passes capability without claiming the review would be accepted', async () => {
  const { args } = deps()
  const r = await runDoctor(args)
  const check = find(r, 'review capability')
  assert.equal(check.ok, true)
  // A permission the App genuinely holds must not be reported as missing over
  // the casing a wrapper happened to hand back.
  const cased = await runDoctor(deps({ appAuth: async () => ({ ...APP_AUTH, permissions: { pull_requests: 'Write', issues: 'WRITE', contents: 'Read' } }) }).args)
  assert.equal(find(cased, 'review capability').ok, true)
  assert.match(check.detail, /pull_requests/)
  assert.match(check.detail, /branch protection|ruleset/i, 'the success message must not overclaim: permission granted is not review accepted')
})

test('an unverifiable installation fails loudly instead of passing silently', async () => {
  // No probe at all, and a probe that throws. Both mean "capability unknown",
  // and unknown must never render as healthy — this check exists precisely
  // because the alternative is discovering it at 422 time, after a full model
  // review has been paid for.
  for (const over of [
    { appAuth: undefined },
    { appAuth: async () => null },
    { appAuth: async () => { throw new Error('installation 999 not found') } },
  ]) {
    const { args } = deps(over)
    const r = await runDoctor(args)
    assert.equal(find(r, 'github identity').ok, false)
    assert.equal(find(r, 'review capability').ok, false)
    assert.match(find(r, 'review capability').detail, /not verified|could not/i)
    assert.equal(r.ok, false)
  }
})

test('doctor never posts a review to prove it can post a review', async () => {
  const forbidden = ['createReview', 'createIssueComment', 'updateIssueComment', 'addLabel', 'removeLabel']
  const { args } = deps()
  for (const name of forbidden) {
    args.github[name] = async () => { throw new Error(`doctor called ${name}, which mutates a real PR`) }
  }
  const r = await runDoctor(args)
  assert.equal(r.ok, true)
})

// ---------------------------------------------------------------------------
// Repos and labels
// ---------------------------------------------------------------------------

test('a failing repo neither masks nor aborts the repos after it', async () => {
  const { calls, args } = deps({
    config: { ...config, repos: ['o/broken', 'o/fine', 'o/also-fine'] },
    github: {
      listOpenPrs: async (repo) => {
        calls.repos.push(repo)
        if (repo === 'o/broken') throw new Error('Resource not accessible by integration')
        return []
      },
    },
  })
  const r = await runDoctor(args)
  assert.equal(find(r, 'repo access: o/broken').ok, false)
  assert.equal(find(r, 'repo access: o/fine').ok, true)
  assert.equal(find(r, 'repo access: o/also-fine').ok, true)
  assert.deepEqual(calls.repos, ['o/broken', 'o/fine', 'o/also-fine'], 'every repo is probed, in order')
  assert.deepEqual([...new Set(calls.labels.map((l) => l.repo))], ['o/fine', 'o/also-fine'], 'labels are not attempted on a repo we cannot even read')
  assert.equal(r.ok, false, 'one dead repo must sink the run')
})

test('all three labels are ensured on every reachable repo', async () => {
  const { calls, args } = deps({ config: { ...config, repos: ['o/a', 'o/b'] } })
  const r = await runDoctor(args)
  assert.equal(calls.labels.length, 6)
  assert.deepEqual(calls.labels.filter((l) => l.repo === 'o/a').map((l) => l.name), ['review-requested', 'review-in-progress', 'review-error'])
  for (const label of calls.labels) {
    assert.match(label.color, /^[0-9a-f]{6}$/, 'GitHub takes a six-digit hex colour without the "#"')
    assert.ok(label.description, 'a label the bot creates in someone else\'s repo must say where it came from')
  }
  assert.equal(find(r, 'label review-requested on o/b').ok, true)
})

test('one label failure does not stop the other labels or the other repos', async () => {
  const { calls, args } = deps({
    config: { ...config, repos: ['o/a', 'o/b'] },
    github: {
      ensureLabel: async (repo, name, color, description) => {
        calls.labels.push({ repo, name, color, description })
        if (name === 'review-in-progress') throw new Error('Resource not accessible by integration')
        return {}
      },
    },
  })
  const r = await runDoctor(args)
  assert.equal(find(r, 'label review-in-progress on o/a').ok, false)
  assert.equal(find(r, 'label review-error on o/a').ok, true, 'the label after the failure still gets checked')
  assert.equal(find(r, 'label review-in-progress on o/b').ok, false)
  assert.equal(calls.labels.length, 6)
  assert.equal(r.ok, false)
})

test('an empty allowlist is a failure, not a silent zero-repo pass', async () => {
  const { args } = deps({ config: { ...config, repos: [] } })
  const r = await runDoctor(args)
  assert.equal(find(r, 'repos configured').ok, false)
  assert.equal(r.ok, false)
})

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

test('a reaction doctor adds is a reaction doctor takes back off', async () => {
  const { calls, args } = deps()
  const r = await runDoctor(args)
  assert.equal(find(r, 'slack reactions').ok, true)
  assert.deepEqual(calls.reactions, [['add', 'white_check_mark', '111.222'], ['remove', 'white_check_mark', '111.222']])
  assert.equal(calls.posts[0].channel, 'C1')
})

test('a channel the bot was never invited to fails with the channel id and the fix', async () => {
  const { args } = deps({ slack: { postMessage: async () => { throw new Error('Slack chat.postMessage failed: not_in_channel') } } })
  const r = await runDoctor(args)
  const post = find(r, 'slack post')
  assert.equal(post.ok, false)
  assert.match(post.detail, /not_in_channel/)
  assert.match(post.detail, /C1/, 'name the channel, so the operator can /invite the bot to the right one')
  // The reaction path could not run. It must be reported as unchecked, not
  // omitted: an operator scanning for "slack reactions" and finding nothing
  // learns nothing, and a doctor that quietly drops checks is the failure mode
  // this whole command exists to prevent.
  assert.equal(find(r, 'slack reactions').ok, false)
  assert.equal(r.ok, false)
})

test('a missing reactions:write scope is named as such', async () => {
  const { args } = deps({ slack: { addReaction: async () => { throw new Error('Slack reactions.add failed: missing_scope') } } })
  const r = await runDoctor(args)
  const check = find(r, 'slack reactions')
  assert.equal(check.ok, false)
  assert.match(check.detail, /missing_scope/)
  assert.match(check.detail, /reactions:write/)
})

test('remove-only failure still fails, because reconciliation removes before it adds', async () => {
  const { args } = deps({ slack: { removeReaction: async () => { throw new Error('Slack reactions.remove failed: missing_scope') } } })
  const r = await runDoctor(args)
  assert.equal(find(r, 'slack reactions').ok, false, 'add alone is not enough: every round takes the previous state emoji off')
  assert.equal(r.ok, false)
})

test('a post that returns no ts fails instead of reacting against undefined', async () => {
  const { calls, args } = deps({ slack: { postMessage: async () => ({}) } })
  const r = await runDoctor(args)
  assert.equal(find(r, 'slack post').ok, false)
  assert.match(find(r, 'slack post').detail, /ts/)
  assert.deepEqual(calls.reactions, [], 'no reaction may be addressed to an undefined message')
  assert.equal(find(r, 'slack reactions').ok, false)
})

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test('a token-shaped value in team.json fails the credential check', async () => {
  const { args } = deps({ config: { ...config, slack: { ...config.slack, botToken: 'xoxb-' + '9999999999-8888888888-abcdefghijklmnopqrstuvwx' } } })
  const r = await runDoctor(args)
  const check = find(r, 'no credentials in config')
  assert.equal(check.ok, false)
  assert.match(check.detail, /botToken/)
  assert.equal(r.ok, false)
})

test('a credential pasted into review-criteria.md is caught too', async () => {
  // validateConfig cannot see this: loadConfig attaches `criteria` AFTER
  // assertNoSecrets has already run over team.json. Doctor scans the assembled
  // config, so the criteria file is the one place this is ever checked.
  const { args } = deps({ config: { ...config, criteria: 'Ask the API with sk-ant-api03-AbCd1234EfGh5678IjKl9012MnOp3456 if unsure.' } })
  const r = await runDoctor(args)
  assert.equal(find(r, 'no credentials in config').ok, false)
})

test('ordinary config values that merely look secret-adjacent are not leaks', async () => {
  // Sibling modules had to fix exactly these false positives, each of which
  // hard-failed startup by accusing the team of committing a credential.
  const { args } = deps({
    config: {
      ...config,
      repos: ['acme/sk-tools', 'acme/sk-learn-Model-2024-experiments-archive'],
      clonesDir: '/opt/sk-review-bot-clones-CI-2026-shard1',
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      credentialHelper: 'osxkeychain',
      secretsManagerPath: 'projects/123456/secrets/PR_BOT_TOKEN',
      maxTokens: 8192,
    },
  })
  const r = await runDoctor(args)
  assert.equal(find(r, 'no credentials in config').ok, true, `false positive: ${find(r, 'no credentials in config').detail}`)
})

test('the tracked-file check names the file and does not fire on an untracked one', async () => {
  const tracked = await runDoctor(deps({ gitTracked: (p) => p.endsWith('.env.local') }).args)
  assert.equal(find(tracked, 'secrets not committed').ok, false)
  assert.match(find(tracked, 'secrets not committed').detail, /\.env\.local/)

  const clean = await runDoctor(deps().args)
  assert.equal(find(clean, 'secrets not committed').ok, true)
})

// ---------------------------------------------------------------------------
// Author mapping, config dir, telemetry
// ---------------------------------------------------------------------------

test('open PRs by unmapped authors are a named warning, not a failure', async () => {
  const { args } = deps({
    github: { listOpenPrs: async () => [{ user: { login: 'octocat' } }, { user: { login: 'dana' } }, { user: { login: 'dana' } }] },
  })
  const r = await runDoctor(args)
  const check = find(r, 'author mapping')
  assert.equal(check.ok, true, 'an unmapped author degrades to unlinked text; it does not stop a review')
  assert.match(check.detail, /dana/)
  assert.doesNotMatch(check.detail, /octocat/, 'a mapped author is not a warning')
  assert.equal(r.ok, true)
})

test('an authorMap entry that is not a usable Slack id counts as unmapped', async () => {
  // resolveMention requires an own string property and ignores an empty one,
  // so doctor must count mappings the same way or it reports coverage the
  // runtime does not have.
  const { args } = deps({
    config: { ...config, authorMap: { octocat: '', dana: null } },
    github: { listOpenPrs: async () => [{ user: { login: 'octocat' } }, { user: { login: 'dana' } }] },
  })
  const r = await runDoctor(args)
  const check = find(r, 'author mapping')
  assert.match(check.detail, /octocat/)
  assert.match(check.detail, /dana/)
})

test('every open PR author mapped reads as covered', async () => {
  const { args } = deps({ github: { listOpenPrs: async () => [{ user: { login: 'octocat' } }] } })
  const r = await runDoctor(args)
  assert.match(find(r, 'author mapping').detail, /1 author/)
  assert.doesNotMatch(find(r, 'author mapping').detail, /unlinked/)
})

test('the config dir check names the directory and which tier produced it', async () => {
  const fromEnv = await runDoctor(deps({ configDir: '/cfg', env: { PR_REVIEW_CONFIG_DIR: '/cfg' } }).args)
  assert.match(find(fromEnv, 'config dir').detail, /\/cfg/)
  assert.match(find(fromEnv, 'config dir').detail, /PR_REVIEW_CONFIG_DIR/)

  const explicit = await runDoctor({ ...deps().args, configSource: '--config' })
  assert.match(find(explicit, 'config dir').detail, /--config/)
})

test('a PR_REVIEW_CONFIG_DIR that did not win is called out, because whose criteria ran must never be ambiguous', async () => {
  const { args } = deps({ configDir: '/cfg', env: { PR_REVIEW_CONFIG_DIR: '/other' } })
  const r = await runDoctor({ ...args, configSource: '--config' })
  const check = find(r, 'config dir')
  assert.match(check.detail, /\/other/, 'the ignored setting has to appear, or the operator debugs the wrong criteria file')
  assert.match(check.detail, /\/cfg/)
  assert.equal(check.ok, true)
})

test('telemetry state is reported both ways', async () => {
  const off = await runDoctor(deps().args)
  assert.match(find(off, 'telemetry').detail, /disabled|off/i)
  const on = await runDoctor(deps({ config: { ...config, telemetry: true } }).args)
  assert.match(find(on, 'telemetry').detail, /enabled|on\b/i)
  assert.equal(find(on, 'telemetry').ok, true)
})

// ---------------------------------------------------------------------------
// The shape of the report itself
// ---------------------------------------------------------------------------

test('one failing check sinks the aggregate, and only that check is blamed', async () => {
  // The whole point of a doctor: "all good" while a check failed is worse than
  // no doctor. Asserting the failure COUNT as well as the flag keeps a future
  // implementation from satisfying this by failing everything.
  const { args } = deps({ slack: { addReaction: async () => { throw new Error('missing_scope') } } })
  const r = await runDoctor(args)
  assert.equal(r.ok, false)
  assert.deepEqual(failedNames(r), ['slack reactions'])
})

test('every check is a named, uniquely addressable triple', async () => {
  const { args } = deps({ config: { ...config, repos: ['o/a', 'o/b'] } })
  const r = await runDoctor(args)
  assert.ok(r.checks.length >= 10)
  for (const check of r.checks) {
    assert.equal(typeof check.name, 'string')
    assert.equal(typeof check.ok, 'boolean', `${check.name} must report a boolean, not something truthy`)
    assert.ok(check.detail && typeof check.detail === 'string', `${check.name} must explain itself`)
  }
  const names = r.checks.map((c) => c.name)
  assert.deepEqual([...new Set(names)], names, 'duplicate names make a report unaddressable')
})
