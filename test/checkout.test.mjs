import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createCheckouts } from '../src/checkout.mjs'

// Every temp tree this suite creates, removed once at the end. A clone dir holds
// a repo plus its worktrees, so leaking one leaks a working tree per test run.
const tmpDirs = []
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

function makeOrigin() {
  const dir = tempDir('origin-')
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 'T')
  writeFileSync(join(dir, 'app.js'), 'export const answer = 42\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  return { dir, sha }
}

test('worktreeForPr materializes the PR head with real readable files', async () => {
  const origin = makeOrigin()
  const clonesDir = tempDir('clones-')
  const checkouts = createCheckouts({ clonesDir, remoteUrlFor: () => origin.dir })

  const wt = await checkouts.worktreeForPr({ repo: 'o/r', number: 1, sha: origin.sha, fetchRef: 'refs/heads/main' })
  assert.ok(existsSync(join(wt.dir, 'app.js')))
  assert.match(readFileSync(join(wt.dir, 'app.js'), 'utf8'), /answer = 42/)

  await wt.cleanup()
  assert.equal(existsSync(join(wt.dir, 'app.js')), false, 'cleanup removes the worktree')
})

test('a second call reuses the existing clone instead of recloning', async () => {
  const origin = makeOrigin()
  const clonesDir = tempDir('clones-')
  const cloned = []
  const checkouts = createCheckouts({
    clonesDir,
    remoteUrlFor: () => origin.dir,
    onClone: (repo) => cloned.push(repo),
  })
  const a = await checkouts.worktreeForPr({ repo: 'o/r', number: 1, sha: origin.sha, fetchRef: 'refs/heads/main' })
  await a.cleanup()
  const b = await checkouts.worktreeForPr({ repo: 'o/r', number: 2, sha: origin.sha, fetchRef: 'refs/heads/main' })
  await b.cleanup()
  assert.deepEqual(cloned, ['o/r'], 'cloned exactly once')
})

// The other two tests use an origin with a single commit, where every SHA that
// exists is the right one — so checking out the branch tip instead of the
// requested SHA is indistinguishable from correct. That is the one failure that
// would be invisible in production too: the review reads real files, passes
// every "the files are there" check, and reviews the wrong revision. Here the
// requested SHA is deliberately NOT the tip of the ref being fetched.
test('the worktree is at the requested SHA, not at the tip of the fetched ref', async () => {
  const origin = makeOrigin()
  const git = (...a) => execFileSync('git', ['-C', origin.dir, ...a], { stdio: 'pipe' })
  writeFileSync(join(origin.dir, 'app.js'), 'export const answer = 99\n')
  writeFileSync(join(origin.dir, 'added-later.js'), 'export const later = true\n')
  git('add', '.')
  git('commit', '-qm', 'second')
  const tipSha = execFileSync('git', ['-C', origin.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.notEqual(tipSha, origin.sha, 'the fixture must actually have two distinct commits')

  const clonesDir = tempDir('clones-')
  const checkouts = createCheckouts({ clonesDir, remoteUrlFor: () => origin.dir })
  const wt = await checkouts.worktreeForPr({ repo: 'o/r', number: 7, sha: origin.sha, fetchRef: 'refs/heads/main' })

  const head = execFileSync('git', ['-C', wt.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(head, origin.sha, 'worktree HEAD must be the requested SHA')
  assert.match(readFileSync(join(wt.dir, 'app.js'), 'utf8'), /answer = 42/)
  assert.equal(existsSync(join(wt.dir, 'added-later.js')), false, 'a file added after the requested SHA must not be present')
  await wt.cleanup()
})
