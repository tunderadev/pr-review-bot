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

// The fetch is the step this module exists to get right, and the three tests
// above cannot see it: they all pass an explicit fetchRef pointing at a branch,
// and cloning from a local path copies the whole object database, so deleting
// the `git fetch` line outright leaves every one of them green. Against real
// GitHub that deletion breaks EVERY pr: a PR head commit sits on no branch and
// refs/pull/* is not advertised to a plain clone, so `worktree add` dies with
// "invalid reference" before a review ever starts.
//
// So this exercises the default refspec — refs/pull/<number>/head, never
// executed above — and puts the commit into the origin only AFTER the clone
// exists. No clone-time copying can mask an object that did not exist yet, and
// the second leg pins the round-2 case: a REUSED clone must still learn about
// new commits, or every re-review silently reads the previous push's code.
//
// GIT_NO_LAZY_FETCH is what makes the assertion mean anything. --filter=blob:none
// registers origin as a PROMISOR remote, so on a missing object git quietly runs
// its own fetch behind the module's back — and against a local origin that
// always succeeds, which is why deleting the module's `git fetch` outright still
// left this test green until the variable was set. Real git and the real runGit
// still do all the work here; only git's silent substitution for the step under
// test is switched off. Without the fetch the worktree add now dies with
// "fatal: invalid reference", the same error production would raise.
test('fetches the PR head through the default refs/pull ref, into a reused clone', async (t) => {
  const origin = makeOrigin()
  const git = (...a) => execFileSync('git', ['-C', origin.dir, ...a], { stdio: 'pipe' })
  const clonesDir = tempDir('clones-')
  const checkouts = createCheckouts({ clonesDir, remoteUrlFor: () => origin.dir })
  const priorNoLazyFetch = process.env.GIT_NO_LAZY_FETCH
  process.env.GIT_NO_LAZY_FETCH = '1'
  t.after(() => {
    if (priorNoLazyFetch === undefined) delete process.env.GIT_NO_LAZY_FETCH
    else process.env.GIT_NO_LAZY_FETCH = priorNoLazyFetch
  })

  // Round 1 creates the clone, back when the origin held only this commit.
  const first = await checkouts.worktreeForPr({ repo: 'o/r', number: 1, sha: origin.sha, fetchRef: 'refs/heads/main' })
  await first.cleanup()

  // A PR head, as GitHub exposes one: reachable from no branch, published only
  // under refs/pull/<number>/head, and created after the clone was taken.
  git('checkout', '-q', '--detach')
  writeFileSync(join(origin.dir, 'hotfix.js'), 'export const fixed = true\n')
  git('add', '.')
  git('commit', '-qm', 'pr head')
  const prSha = execFileSync('git', ['-C', origin.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  git('update-ref', 'refs/pull/22/head', prSha)
  git('checkout', '-q', 'main')
  assert.equal(
    execFileSync('git', ['-C', origin.dir, 'branch', '--contains', prSha], { encoding: 'utf8' }).trim(),
    '',
    'the fixture PR head must be reachable from no branch, like a real one'
  )

  // No fetchRef: this is the default refs/pull/22/head path Task 13 relies on.
  const wt = await checkouts.worktreeForPr({ repo: 'o/r', number: 22, sha: prSha })
  const head = execFileSync('git', ['-C', wt.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(head, prSha, 'worktree HEAD must be the PR head fetched via refs/pull/22/head')
  assert.match(readFileSync(join(wt.dir, 'hotfix.js'), 'utf8'), /fixed = true/)
  await wt.cleanup()
})
