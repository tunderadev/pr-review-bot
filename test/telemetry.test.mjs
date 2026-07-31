import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createTelemetry, summarize, resetTelemetry, DEFAULT_TELEMETRY_PATH } from '../src/telemetry.mjs'

// Removed once at the end. A suite that tests "measurement leaves nothing on
// disk" has no business leaking a temp tree per run.
const tmpDirs = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-'))
  tmpDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

test('disabled telemetry writes nothing and creates no file', () => {
  const dir = tempDir()
  const path = join(dir, 'telemetry.jsonl')
  const t = createTelemetry({ enabled: false, path })
  assert.equal(t.enabled, false, 'the flag is readable, so callers can skip building entries at all')
  assert.equal(t.record({ phase: 'review', costUsd: 1 }), false)
  assert.equal(existsSync(path), false, 'no file may exist when telemetry is off')

  // Stronger than "the log is absent". An implementation that opened the log
  // for append and closed it, or that created the log's parent directory
  // before consulting the flag, can still satisfy the assertion above on some
  // paths while leaving a trace on disk. The operator asked for a switch that
  // is genuinely inert: nothing may appear, not even an empty directory.
  const nested = createTelemetry({ enabled: false, path: join(dir, 'runs', 'telemetry.jsonl') })
  assert.equal(nested.record({ phase: 'verify', costUsd: 2 }), false)
  assert.deepEqual(readdirSync(dir), [], 'the off path must leave the filesystem untouched')
})

test('enabled telemetry appends one JSON object per line', () => {
  const path = join(tempDir(), 'nested', 'telemetry.jsonl')
  const t = createTelemetry({ enabled: true, path })
  assert.equal(t.enabled, true)
  assert.equal(t.record({ phase: 'review', costUsd: 0.4 }), true)
  t.record({ phase: 'verify', costUsd: 0.1 })
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).phase, 'review')
})

test('summarize aggregates cost per review for the depth-2 decision', () => {
  const jsonl = [
    { repo: 'o/r', number: 1, phase: 'review', costUsd: 0.4, model: 'claude-opus-5', inputTokens: 10, outputTokens: 5 },
    { repo: 'o/r', number: 1, phase: 'verify', costUsd: 0.1, model: 'claude-opus-5', inputTokens: 3, outputTokens: 1 },
    { repo: 'o/r', number: 2, phase: 'review', costUsd: 0.6, model: 'claude-opus-5', inputTokens: 8, outputTokens: 4 },
  ].map((e) => JSON.stringify(e)).join('\n')

  const s = summarize(jsonl)
  assert.equal(s.reviews, 2, 'a review is one PR round, not one model call')
  assert.equal(Number(s.totalCostUsd.toFixed(2)), 1.1)
  assert.equal(Number(s.avgCostUsd.toFixed(2)), 0.55)
  assert.equal(Number(s.maxCostUsd.toFixed(2)), 0.6)
  assert.equal(s.byPhase.verify.calls, 1)
  assert.equal(s.byPhase.review.calls, 2)
  assert.equal(Number(s.byPhase.verify.costUsd.toFixed(2)), 0.1)
  assert.equal(s.byModel['claude-opus-5'].calls, 3)
  // Calls roll up per model as well as per review, because the depth-2
  // question is answered in dollars per review but priced per model.
  assert.equal(Number(s.byModel['claude-opus-5'].costUsd.toFixed(2)), 1.1)
  assert.equal(s.byModel['claude-opus-5'].inputTokens, 21)
  assert.equal(s.byModel['claude-opus-5'].outputTokens, 10)
})

test('summarize counts a re-review of the same PR as its own review', () => {
  // Rounds 1 and 2 of PR 7 are two reviews, and round 1 spans two calls. An
  // implementation that keyed only on repo+number would fold them into one and
  // halve the measured cost per review; one that counted calls would report
  // three. Both mistakes answer the depth-2 question wrongly.
  const jsonl = [
    { repo: 'o/r', number: 7, round: 1, phase: 'review', costUsd: 0.3, model: 'claude-opus-5' },
    { repo: 'o/r', number: 7, round: 1, phase: 'verify', costUsd: 0.3, model: 'claude-opus-5' },
    { repo: 'o/r', number: 7, round: 2, phase: 'review', costUsd: 0.2, model: 'claude-opus-5' },
  ].map((e) => JSON.stringify(e)).join('\n')

  const s = summarize(jsonl)
  assert.equal(s.reviews, 2, 'round 2 is a second review of the same PR, not more of the first')
  assert.equal(Number(s.avgCostUsd.toFixed(2)), 0.4)
  assert.equal(Number(s.maxCostUsd.toFixed(2)), 0.6, 'the priciest review is the multi-call one, not the priciest single call')
})

test('summarize tolerates blank lines and garbage', () => {
  const s = summarize('\n{"phase":"review","costUsd":1,"repo":"o/r","number":1}\nnot json\n\n')
  assert.equal(s.reviews, 1)

  // The line order above puts the garbage last, so a parser that gave up at the
  // first bad line would still score 1. Rows on BOTH sides of the damage must
  // survive: a half-flushed final write is the realistic way this file goes
  // bad, and it must not cost the operator the measurements taken before it.
  const around = summarize([
    '{"phase":"review","costUsd":1,"repo":"o/r","number":1,"model":"claude-opus-5"}',
    '{"phase":"review","costUsd":2,"repo":"o/r"',
    'not json',
    '{"phase":"verify","costUsd":3,"repo":"o/r","number":2,"model":"claude-opus-5"}',
  ].join('\n'))
  assert.equal(around.reviews, 2, 'valid rows after a garbage line are still counted')
  assert.equal(around.totalCostUsd, 4)
  assert.equal(around.byModel['claude-opus-5'].calls, 2)
})

test('summarize of an empty log reports zeroes rather than throwing', () => {
  const s = summarize('')
  assert.deepEqual(
    { reviews: s.reviews, totalCostUsd: s.totalCostUsd, avgCostUsd: s.avgCostUsd, maxCostUsd: s.maxCostUsd },
    { reviews: 0, totalCostUsd: 0, avgCostUsd: 0, maxCostUsd: 0 },
  )
  assert.deepEqual(s.byPhase, {})
  assert.deepEqual(s.byModel, {})
})

test('resetTelemetry clears the log so the next window starts empty', () => {
  const path = join(tempDir(), 'telemetry.jsonl')
  const t = createTelemetry({ enabled: true, path })
  t.record({ phase: 'review', costUsd: 1, repo: 'o/r', number: 1 })
  assert.equal(existsSync(path), true)

  assert.equal(resetTelemetry(path), true, 'reports that it removed something')
  assert.equal(existsSync(path), false, 'no .bak or leftover file may remain')
  // The assertion above only inspects the log's own path, so rotating it to
  // telemetry.jsonl.bak would satisfy it while leaving exactly the file the
  // operator does not want accumulating. Check the whole directory instead.
  assert.deepEqual(readdirSync(dirname(path)), [], 'reset must delete the log, not rotate it')

  assert.equal(resetTelemetry(path), false, 'resetting an already-clear log is a harmless no-op')

  t.record({ phase: 'review', costUsd: 2, repo: 'o/r', number: 2 })
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, 'recording after a reset starts from a clean file')
  assert.equal(JSON.parse(lines[0]).costUsd, 2)
})

test('the default log lives under the operator config dir, never the working directory', () => {
  // A relative default would drop a .jsonl into whatever repo the bot was run
  // from, which is both a surprise and a thing that gets committed.
  assert.ok(DEFAULT_TELEMETRY_PATH.startsWith(homedir()), `expected an absolute path under the home dir, got ${DEFAULT_TELEMETRY_PATH}`)
  assert.match(DEFAULT_TELEMETRY_PATH, /pr-review-bot[/\\]telemetry\.jsonl$/)
})
