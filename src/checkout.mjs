import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function createCheckouts({
  clonesDir,
  remoteUrlFor = (repo) => `https://github.com/${repo}.git`,
  onClone = () => {},
  runGit = async (args, cwd) => (await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout,
}) {
  async function ensureClone(repo) {
    const dir = join(clonesDir, repo.replace('/', '__'))
    if (existsSync(join(dir, '.git'))) return dir
    mkdirSync(clonesDir, { recursive: true })
    onClone(repo)
    // blob:none keeps the clone small; blobs are fetched on demand when files are read.
    await runGit(['clone', '--filter=blob:none', '--no-checkout', remoteUrlFor(repo), dir])
    return dir
  }

  return {
    async worktreeForPr({ repo, number, sha, fetchRef = `refs/pull/${number}/head` }) {
      const cloneDir = await ensureClone(repo)
      await runGit(['fetch', '--force', 'origin', `${fetchRef}:refs/pr-review-bot/${number}`], cloneDir)
      const dir = join(cloneDir, '.worktrees', `${number}-${sha.slice(0, 7)}`)
      rmSync(dir, { recursive: true, force: true })
      await runGit(['worktree', 'prune'], cloneDir)
      await runGit(['worktree', 'add', '--detach', '--force', dir, sha], cloneDir)
      return {
        dir,
        cleanup: async () => {
          await runGit(['worktree', 'remove', '--force', dir], cloneDir).catch(() => {})
          rmSync(dir, { recursive: true, force: true })
        },
      }
    },
  }
}
