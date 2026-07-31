import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// A blob:none clone of a large repo is slow, so this is generous. It exists to
// bound a WEDGED call, not to police a slow one.
export const DEFAULT_GIT_TIMEOUT_MS = 5 * 60_000

// This process runs unattended on a timer, so there is no one to answer a
// prompt: git blocking on a username, a passphrase, or a host-key confirmation
// stops every future review with no error and no output. Each of these closes
// one way git can decide to wait for a human — the terminal, the askpass dialog
// a credential helper can pop, and ssh's own interactive checks.
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  SSH_ASKPASS_REQUIRE: 'never',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
}

// Credentials travel per invocation, in the environment. Not in argv, which any
// other process on the machine can read out of `ps`, and above all not in
// .git/config, which persists: an installation token lives an hour, the clone
// lives for weeks, and that config file sits two directories above the worktree
// headless Claude is pointed at with Read and Grep.
function credentialEnv(credential) {
  if (!credential) return {}
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(credential).toString('base64')}`,
  }
}

// ---------------------------------------------------------------------------
// Sanitization
//
// The worktree this module produces becomes the WORKING DIRECTORY of a headless
// `claude`, and every byte in it was chosen by the PR author. Claude Code reads
// its project configuration from that directory at session start:
// `.claude/settings.json` can declare a SessionStart hook, and `.mcp.json` can
// declare an MCP server — both of which are shell commands, neither of which is
// a TOOL, so `--allowed-tools 'Read Grep Glob'` gates neither. A PR containing
// either runs arbitrary code as the operator, with the operator's environment,
// before the review has read one line of the diff. For any repo that accepts
// fork PRs, the trigger is available to anyone whose PR a maintainer labels.
//
// So the sanitization lives HERE, in the function that produces the worktree,
// rather than in the caller that spawns the reviewer: the tree handed back is
// already safe and no future caller can forget to make it so.
//
// Removing these costs the review nothing. The authority on how to review is
// the team's own review-criteria.md, which travels in the prompt; anything the
// PR itself has to say about how it would like to be reviewed is not evidence.
const AGENT_CONFIG_NAMES = new Set([
  '.claude', // settings.json (hooks, env, permissions), agents/, commands/, hooks/, skills/
  '.claude-plugin', // plugin.json and marketplace.json
  '.mcp.json', // mcpServers[].command — a shell command, executed at startup
  'claude.md',
  'claude.local.md',
  'agents.md',
])

// Lower-cased, because macOS — the laptop deployment this tool is designed for —
// is case-insensitive by default: a file committed as `.CLAUDE/settings.json`
// IS `.claude/settings.json` to everything that opens it, Claude Code included.
// A case-sensitive match would be a one-keystroke bypass of the whole layer.
const isAgentConfig = (name) => AGENT_CONFIG_NAMES.has(name.toLowerCase())

// Returns the worktree-relative paths it removed. Never absolute: this list is
// logged, and no local path of the operator's belongs in output.
export function sanitizeWorktree(dir) {
  const removed = []
  // An explicit worklist rather than recursion: the depth here is chosen by the
  // PR author, and a pathological tree must not be able to overflow the stack of
  // a process that runs unattended.
  const pending = [{ abs: dir, rel: '' }]
  while (pending.length) {
    const { abs, rel } = pending.pop()
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      // A directory that vanished or cannot be read is not a reason to fail a
      // review; there is nothing in it left to strip.
      continue
    }
    for (const entry of entries) {
      // Never descended into and never removed: the repository's own metadata,
      // which the PR author cannot write through a checkout anyway.
      if (entry.name === '.git') continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (isAgentConfig(entry.name)) {
        // rmSync on a SYMLINK unlinks the link and leaves its target alone, so a
        // planted `.claude -> ~/.claude` deletes the plant, not the operator's
        // own configuration.
        rmSync(join(abs, entry.name), { recursive: true, force: true })
        removed.push(childRel)
        continue
      }
      // isDirectory() is false for a symlink — readdir reports the link itself,
      // not what it points at — so the walk can never be steered out of the
      // worktree by a link the PR author committed.
      if (entry.isDirectory()) pending.push({ abs: join(abs, entry.name), rel: childRel })
    }
  }
  return removed.sort()
}

// Embedding the token in the clone URL is the obvious way to authenticate, and
// it is the one that persists it. A caller who does it anyway gets the
// credential lifted out of the URL and delivered the safe way instead, so the
// stored remote is credential-free however the caller supplies it.
export function splitCredential(url) {
  const match = /^(https?:\/\/)([^/@]+)@(.+)$/.exec(String(url))
  if (!match) return { url, credential: null }
  // Userinfo is percent-encoded by convention, but a token pasted in raw can
  // carry a bare "%" that decodeURIComponent throws on. A malformed escape is
  // not worth killing the review cycle over — use it as written.
  let credential = match[2]
  try {
    credential = decodeURIComponent(credential)
  } catch {}
  return { url: `${match[1]}${match[3]}`, credential }
}

export function createCheckouts({
  clonesDir,
  remoteUrlFor = (repo) => `https://github.com/${repo}.git`,
  // Called once per worktreeForPr and never cached: an installation token
  // expires an hour after it is minted, and the clone outlives it by days.
  credentialFor = () => null,
  onClone = () => {},
  gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  runGit = async (args, cwd, { env = {}, timeoutMs } = {}) =>
    (
      await execFileAsync('git', args, {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...env },
        timeout: timeoutMs,
      })
    ).stdout,
}) {
  async function ensureClone(repo, url, git) {
    const dir = join(clonesDir, repo.replace('/', '__'))
    if (existsSync(join(dir, '.git'))) return dir
    mkdirSync(clonesDir, { recursive: true })
    onClone(repo)
    // blob:none keeps the clone small; blobs are fetched on demand when files are read.
    await git(['clone', '--filter=blob:none', '--no-checkout', url, dir])
    return dir
  }

  // A review killed mid-flight never runs cleanup(), so its worktree directory
  // survives — and `worktree prune` deliberately will not touch a registration
  // whose directory still exists. Left alone these accumulate one per crash,
  // each a full checkout. Clearing this PR's leftovers first is what lets the
  // prune that follows actually reclaim the registrations.
  function removeWorktreesFor(cloneDir, number) {
    const root = join(cloneDir, '.worktrees')
    if (!existsSync(root)) return
    for (const entry of readdirSync(root)) {
      if (entry === String(number) || entry.startsWith(`${number}-`)) {
        rmSync(join(root, entry), { recursive: true, force: true })
      }
    }
  }

  return {
    async worktreeForPr({ repo, number, sha, fetchRef = `refs/pull/${number}/head` }) {
      const remote = splitCredential(remoteUrlFor(repo))
      const credential = credentialFor(repo) || remote.credential
      const env = { ...NON_INTERACTIVE_ENV, ...credentialEnv(credential) }
      const git = (args, cwd) => runGit(args, cwd, { env, timeoutMs: gitTimeoutMs })

      const cloneDir = await ensureClone(repo, remote.url, git)
      // Fetched by explicit URL rather than through the stored remote, so the
      // remote never has to carry authentication to stay useful.
      const ref = `refs/pr-review-bot/${number}`
      await git(['fetch', '--force', remote.url, `${fetchRef}:${ref}`], cloneDir)

      const dir = join(cloneDir, '.worktrees', `${number}-${sha.slice(0, 7)}`)
      removeWorktreesFor(cloneDir, number)
      await git(['worktree', 'prune'], cloneDir)
      await git(['worktree', 'add', '--detach', '--force', dir, sha], cloneDir)
      // The ref has done its job: the worktree's own detached HEAD keeps the
      // commit alive from here, so drop it rather than leaving one ref per PR
      // ever reviewed pinned inside the clone forever.
      await git(['update-ref', '-d', ref], cloneDir).catch(() => {})
      // Before the worktree is handed to anyone, and so before any `claude` can
      // be pointed at it. Not the caller's job: a caller who forgets gives a
      // stranger's PR a shell on the operator's machine.
      const removed = sanitizeWorktree(dir)
      return {
        dir,
        removed,
        cleanup: async () => {
          await git(['worktree', 'remove', '--force', dir], cloneDir).catch(() => {})
          rmSync(dir, { recursive: true, force: true })
          await git(['update-ref', '-d', ref], cloneDir).catch(() => {})
        },
      }
    },
  }
}
