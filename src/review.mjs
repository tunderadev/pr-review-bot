import { spawn } from 'node:child_process'

export class VerdictParseError extends Error {}

const SEVERITIES = new Set(['blocking', 'nit'])

const CONTRACT = `Respond with ONLY a JSON object, no prose and no code fence:
{
  "summary": "2-4 sentences on what this PR does",
  "findings": [
    { "severity": "blocking" | "nit", "file": "path/from/repo/root", "line": 42,
      "claim": "one sentence stating the defect", "why": "concrete failure this causes" }
  ],
  "previousBlockersResolved": [ { "claim": "prior blocking claim", "resolved": true, "how": "what changed" } ]
}
Use "blocking" only for defects that must be fixed before merge. Style preferences are "nit".`

export function buildReviewPrompt({ criteria, pr, diff, previousBlockers = [], skippedFiles = [] }) {
  return [
    `You are reviewing pull request ${pr.repo}#${pr.number} at commit ${pr.headSha}.`,
    `Title: ${pr.title}`,
    `Author: ${pr.author}`,
    '',
    'The repository is checked out at this PR head in your working directory. Read and grep real files to confirm anything the diff alone cannot settle.',
    '',
    '## Review criteria (authoritative — judge against these, not your own preferences)',
    criteria,
    '',
    previousBlockers.length
      ? `## Blocking findings from your previous review\nFor each, decide whether it is now resolved and report it in previousBlockersResolved.\n${previousBlockers.map((b) => `- ${b.file}:${b.line} — ${b.claim}`).join('\n')}`
      : '## Previous reviews\nNone. This is the first round.',
    '',
    skippedFiles.length
      ? `## Files excluded from the diff below (too large)\n${skippedFiles.map((f) => `- ${f}`).join('\n')}\nSay so in your summary if this limits your confidence.`
      : '',
    '',
    '## Diff',
    '```diff',
    diff,
    '```',
    '',
    CONTRACT,
  ]
    .filter(Boolean)
    .join('\n')
}

export function parseVerdict(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const start = fenced ? fenced[1] : text
  const first = start.indexOf('{')
  const last = start.lastIndexOf('}')
  if (first === -1 || last <= first) throw new VerdictParseError(`No JSON object in model output: ${text.slice(0, 200)}`)
  let parsed
  try {
    parsed = JSON.parse(start.slice(first, last + 1))
  } catch (e) {
    throw new VerdictParseError(`Verdict JSON did not parse: ${e.message}`)
  }
  if (typeof parsed.summary !== 'string') throw new VerdictParseError('Verdict missing "summary" string')
  if (!Array.isArray(parsed.findings)) throw new VerdictParseError('Verdict missing "findings" array')
  for (const f of parsed.findings) {
    // A null or string element would make the field checks below throw a
    // TypeError, which runReview does not retry and the caller cannot classify.
    // Every way the model can get this wrong has to arrive as a parse failure.
    if (!f || typeof f !== 'object') throw new VerdictParseError(`Finding is not an object: ${JSON.stringify(f)}`)
    if (!SEVERITIES.has(f.severity)) throw new VerdictParseError(`Bad severity "${f.severity}" (expected blocking|nit)`)
    if (typeof f.claim !== 'string' || typeof f.file !== 'string') throw new VerdictParseError('Finding needs string "file" and "claim"')
  }
  // The caller iterates this. "Absent" and "null" both mean none, but a string
  // or an object here is a contract violation, and passing it through would
  // turn a bad verdict into a crash a layer down instead of a retry here.
  const resolved = parsed.previousBlockersResolved
  if (resolved != null && !Array.isArray(resolved)) throw new VerdictParseError('"previousBlockersResolved" must be an array')
  return { summary: parsed.summary, findings: parsed.findings, previousBlockersResolved: resolved || [] }
}

// No --model: headless children inherit the operator's saved CLI default.
const CLAUDE_ARGS = ['-p', '--output-format', 'json', '--allowed-tools', 'Read Grep Glob']

// A deep review of a large PR is legitimately slow, so this is generous: it
// exists to bound a WEDGED child, not a slow one.
export const DEFAULT_REVIEW_TIMEOUT_MS = 20 * 60_000

// Deliberately NOT a usage-limit-shaped failure. A timeout is classified as a
// per-PR failure and earns the sticky review-error label, because this tool
// polls every few minutes on a developer's laptop and spends their personal
// subscription quota — the same quota funding their interactive work. A hung
// review treated as transient would be retried every cycle indefinitely,
// burning that quota with nobody ever seeing a signal, whereas a sticky label
// stops after one occurrence and surfaces the problem to a human. The likeliest
// cause is PR-specific anyway (a pathological or enormous diff), which is
// exactly what the per-PR label is for.
export class ReviewTimeoutError extends Error {}

export function runClaude({ prompt, cwd, spawnImpl = spawn, timeoutMs = DEFAULT_REVIEW_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawnImpl('claude', CLAUDE_ARGS, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let settled = false
    // One settlement, and the timer dies with it: a child that closes normally
    // must not be killed minutes later, and a killed child's own 'close' must
    // not overwrite the timeout with a bland exit code.
    const settle = (finish, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish(value)
    }
    const timer = setTimeout(() => {
      const durationMs = Date.now() - startedAt
      // SIGKILL rather than SIGTERM: this child is wedged, it holds nothing
      // worth flushing (it may Read, Grep and Glob and nothing else), and a
      // TERM it is too stuck to handle would leave an orphan holding the
      // worktree open against the next cycle's cleanup.
      child.kill?.('SIGKILL')
      // Named budget and elapsed time, because a human reading the review-error
      // label needs to know the review hung rather than guess at it.
      const message = `claude timed out after ${durationMs}ms (limit ${timeoutMs}ms) reviewing ${cwd}`
      settle(reject, Object.assign(new ReviewTimeoutError(message), {
        run: { result: message, isError: true, exitCode: null, usage: {}, costUsd: 0, durationMs, model: null, timedOut: true },
      }))
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => settle(reject, e))
    // A child that dies before it has read the whole prompt breaks the pipe.
    // Unhandled, that 'error' event is an uncaught exception in a process that
    // runs unattended; the close handler below still reports the failed run.
    child.stdin.on('error', () => {})
    child.on('close', (exitCode) => {
      let envelope = {}
      try {
        envelope = JSON.parse(out)
      } catch {
        return settle(resolve, { result: out || err, isError: true, exitCode, usage: {}, costUsd: 0, durationMs: 0, model: null })
      }
      const model = Object.values(envelope.modelUsage || {})[0]?.canonicalModel ?? null
      settle(resolve, {
        result: envelope.result ?? '',
        isError: Boolean(envelope.is_error) || envelope.subtype !== 'success',
        exitCode,
        usage: envelope.usage || {},
        costUsd: envelope.total_cost_usd ?? 0,
        durationMs: envelope.duration_ms ?? 0,
        model,
      })
    })
    child.stdin.end(prompt)
  })
}

// \b429\b, not 429: this reads error text that carries durations and byte
// counts, and "timed out after 1429ms" is not a quota event. Reading one as a
// quota event would put a permanently broken review on the transient path,
// where nothing stops it being retried every cycle.
export function isUsageLimit(run) {
  return Boolean(run.isError) && /usage limit|rate limit|quota|\b429\b/i.test(run.result || '')
}

export async function runReview({ criteria, pr, diff, previousBlockers, skippedFiles, cwd, spawnImpl, timeoutMs }) {
  const prompt = buildReviewPrompt({ criteria, pr, diff, previousBlockers, skippedFiles })
  // Every attempt is reported, not just the one that parsed. Telemetry exists to
  // answer "can I afford the deeper review mode?", and a retried review is the
  // expensive kind: dropping the first attempt understates the cost of exactly
  // the reviews that cost the most. `runs` is the contract; `run` is the last.
  const runs = []
  const attempt = async (text) => {
    try {
      const run = await runClaude({ prompt: text, cwd, spawnImpl, timeoutMs })
      runs.push(run)
      return run
    } catch (e) {
      if (e.run) runs.push(e.run)
      throw Object.assign(e, { runs })
    }
  }
  let run = await attempt(prompt)
  try {
    return { verdict: parseVerdict(run.result), run, runs }
  } catch (e) {
    if (!(e instanceof VerdictParseError)) throw Object.assign(e, { runs })
    // A quota wall is not this PR's fault and a second call cannot climb it. The
    // run travels with the error so the caller can restore the trigger label and
    // retry next cycle, instead of applying the sticky error label a human has
    // to clear by hand.
    if (isUsageLimit(run)) throw Object.assign(e, { run, runs })
    const retry = `${prompt}\n\nYour previous response was not valid JSON. Respond with ONLY the JSON object described above.`
    run = await attempt(retry)
    try {
      return { verdict: parseVerdict(run.result), run, runs }
    } catch (e2) {
      if (!(e2 instanceof VerdictParseError)) throw Object.assign(e2, { runs })
      throw Object.assign(e2, { run, runs })
    }
  }
}
