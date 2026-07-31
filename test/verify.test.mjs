import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { buildRefutationPrompt, parseRefutation, refuteBlockers } from '../src/verify.mjs'

const PR = { repo: 'o/r', number: 7, headSha: 'abc1234' }
const blocking = (claim) => ({ severity: 'blocking', file: 'src/a.ts', line: 1, claim, why: 'w' })

function fakeSpawn(results) {
  const calls = []
  const killed = []
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter()
    const call = { cmd, args, cwd: opts?.cwd, prompt: '' }
    calls.push(call)
    child.stdin = new Writable({ write(c, e, cb) { call.prompt += c; cb() }, final(cb) { cb() } })
    const result = results.shift()
    child.stdout = Readable.from([JSON.stringify({ result, is_error: false, usage: {}, total_cost_usd: 0, duration_ms: 1, subtype: 'success' })])
    child.stderr = Readable.from([])
    child.kill = (signal) => { killed.push(signal); return true }
    // A `null` result is a wedged child: it never closes, so only the timeout
    // can settle it.
    if (result !== null) setImmediate(() => child.emit('close', 0))
    return child
  }
  impl.calls = calls
  impl.killed = killed
  return impl
}

test('refutation prompt instructs a refute-by-default posture', () => {
  const p = buildRefutationPrompt({ finding: blocking('unhandled null'), pr: PR })
  assert.ok(p.includes('unhandled null'))
  assert.match(p, /refut/i)
  assert.match(p, /uncertain/i)
})

test('parseRefutation reads the boolean, defaulting to refuted when unreadable', () => {
  assert.deepEqual(parseRefutation('{"refuted":false,"why":"real bug"}'), { refuted: false, why: 'real bug' })
  assert.equal(parseRefutation('{"refuted":true,"why":"guarded upstream"}').refuted, true)
  assert.equal(parseRefutation('I think maybe?').refuted, true, 'unparseable means refuted')
})

test('only surviving blockers pass through; nits are never verified', async () => {
  const findings = [blocking('real'), blocking('bogus'), { severity: 'nit', file: 'f', line: 1, claim: 'nit', why: 'w' }]
  const out = await refuteBlockers({
    findings, pr: PR, cwd: '/wt',
    spawnImpl: fakeSpawn(['{"refuted":false,"why":"confirmed"}', '{"refuted":true,"why":"guarded upstream"}']),
  })
  assert.deepEqual(out.survivors.map((f) => f.claim), ['real'])
  assert.deepEqual(out.refuted.map((f) => f.claim), ['bogus'])
  assert.equal(out.runs.length, 2, 'exactly one run per blocking finding')
})

test('no blocking findings means no model calls at all', async () => {
  const out = await refuteBlockers({ findings: [{ severity: 'nit', file: 'f', line: 1, claim: 'n', why: 'w' }], pr: PR, cwd: '/wt', spawnImpl: fakeSpawn([]) })
  assert.deepEqual(out.survivors, [])
  assert.equal(out.runs.length, 0)
})

// --- Additional coverage. Each of these fails against a plausible wrong
// implementation that the assertions above would have accepted.

test('a clean PR spawns nothing: the run count is not the only thing that must be zero', async () => {
  // `runs.length === 0` above is satisfied by an implementation that calls the
  // model and forgets to record the run — which is the expensive mistake, since
  // the common case is a PR with no blockers at all.
  const impl = fakeSpawn(['{"refuted":true,"why":"x"}'])
  const out = await refuteBlockers({ findings: [{ severity: 'nit', file: 'f', line: 1, claim: 'n', why: 'w' }], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.equal(impl.calls.length, 0, 'zero blocking findings must cost zero child processes')
  assert.deepEqual(out.survivors, [])
  assert.deepEqual(out.refuted, [])
  assert.equal(out.runs.length, 0)
})

test('each refutation runs against the checked-out PR head and names its own claim', async () => {
  // A refuter that cannot read the code around the claim cannot find the guard
  // the reviewer missed; without cwd it is just the reviewer guessing twice.
  const impl = fakeSpawn(['{"refuted":true,"why":"a"}', '{"refuted":true,"why":"b"}'])
  await refuteBlockers({ findings: [blocking('first claim'), blocking('second claim')], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.equal(impl.calls.length, 2)
  assert.deepEqual(impl.calls.map((c) => c.cwd), ['/wt', '/wt'])
  assert.ok(impl.calls[0].prompt.includes('first claim'), 'each call attacks its own finding')
  assert.ok(impl.calls[1].prompt.includes('second claim'))
  assert.ok(!impl.calls[0].prompt.includes('second claim'), 'one claim per call, not the whole list')
})

test('a confident-sounding but unreadable refutation still drops the finding', async () => {
  // The dangerous inversion is defaulting to NOT refuted: it lets garbage — or
  // a model that only ever writes prose — block a colleague's PR.
  const impl = fakeSpawn(['Yes, this is definitely a real bug and it must be fixed before merge.'])
  const out = await refuteBlockers({ findings: [blocking('real')], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.deepEqual(out.survivors, [], 'no verdict is not a surviving verdict')
  assert.deepEqual(out.refuted.map((f) => f.claim), ['real'])
  assert.equal(out.runs.length, 1)
})

test('every blocker lands in exactly one list, keeping its fields and its reason', async () => {
  const findings = [blocking('a'), blocking('b'), blocking('c'), { severity: 'nit', file: 'f', line: 9, claim: 'n', why: 'w' }]
  const out = await refuteBlockers({
    findings, pr: PR, cwd: '/wt',
    spawnImpl: fakeSpawn(['{"refuted":false,"why":"traced it"}', '{"refuted":true,"why":"guarded"}', '{"refuted":false,"why":"traced it too"}']),
  })
  const placed = [...out.survivors, ...out.refuted].map((f) => f.claim).sort()
  assert.deepEqual(placed, ['a', 'b', 'c'], 'each blocker placed once, and no nit placed at all')
  assert.deepEqual(out.survivors.map((f) => f.claim), ['a', 'c'])
  assert.deepEqual(out.refuted.map((f) => f.claim), ['b'])
  assert.deepEqual(out.survivors[0], { severity: 'blocking', file: 'src/a.ts', line: 1, claim: 'a', why: 'w', confirmation: 'traced it' })
  assert.equal(out.refuted[0].refutation, 'guarded', 'the reason survives for whoever renders it')
})

test('a timed-out refutation drops its finding and does not strand the ones after it', async () => {
  // Refute-by-default covers a refuter that never answers, not just one that
  // answers badly: a single wedged child must not fail an otherwise-complete
  // review, and must not block the author on a claim nobody verified.
  const impl = fakeSpawn([null, '{"refuted":false,"why":"traced it"}'])
  const out = await refuteBlockers({ findings: [blocking('slow'), blocking('real')], pr: PR, cwd: '/wt', spawnImpl: impl, timeoutMs: 25 })
  assert.deepEqual(out.survivors.map((f) => f.claim), ['real'], 'the later blocker is still verified')
  assert.deepEqual(out.refuted.map((f) => f.claim), ['slow'])
  assert.match(out.refuted[0].refutation, /timed out/i, 'the drop says it was never verified, not that it was cleared')
  // This reason can reach a public comment; the operator's home directory,
  // which runClaude's timeout message carries, must not travel with it.
  assert.ok(!out.refuted[0].refutation.includes('/wt'), 'no local worktree path in a reason that may be rendered')
  assert.deepEqual(impl.killed, ['SIGKILL'], 'no orphan left holding the worktree open')
  assert.equal(out.runs.length, 2, 'the burned attempt is still reported to telemetry')
  assert.equal(out.runs[0].timedOut, true)
  assert.equal(out.runs[0].isError, true)
})

test('a refutation that never launched fails loudly, and still reports what it already spent', async () => {
  // A timeout hands back a recordable run, so a dropped finding is at least
  // visible in telemetry. A child that cannot spawn hands back nothing: swallowing
  // it would drop every blocker with no trace anywhere.
  const good = fakeSpawn(['{"refuted":true,"why":"guarded"}'])
  let spawns = 0
  const impl = (...args) => {
    if (spawns++ === 0) return good(...args)
    const child = new EventEmitter()
    child.stdin = new Writable({ write(c, e, cb) { cb() }, final(cb) { cb() } })
    child.stdout = Readable.from([])
    child.stderr = Readable.from([])
    setImmediate(() => child.emit('error', new Error('spawn claude ENOENT')))
    return child
  }

  const err = await refuteBlockers({ findings: [blocking('first'), blocking('second')], pr: PR, cwd: '/wt', spawnImpl: impl }).then(
    () => null,
    (e) => e,
  )
  assert.match(err?.message ?? '', /ENOENT/, 'an unlaunchable refuter must not resolve as an approval')
  assert.equal(err.runs.length, 1, 'the refutation that did run still cost quota, and telemetry still needs it')
})

test('a refuter that errored out leaves a marked run, so a caller can tell cleared from unverified', async () => {
  // Refute-by-default sends a failed refutation the same way as an uncertain
  // one: the finding is dropped. `runs` is the only evidence that the drop was
  // an infrastructure failure rather than a verdict, so it has to carry it.
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter()
    child.stdin = new Writable({ write(c, e, cb) { cb() }, final(cb) { cb() } })
    child.stdout = Readable.from([JSON.stringify({ result: 'Claude AI usage limit reached', is_error: true, subtype: 'error_during_execution', usage: {}, total_cost_usd: 0, duration_ms: 1 })])
    child.stderr = Readable.from([])
    setImmediate(() => child.emit('close', 1))
    return child
  }
  const out = await refuteBlockers({ findings: [blocking('real')], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.deepEqual(out.survivors, [])
  assert.deepEqual(out.refuted.map((f) => f.claim), ['real'])
  assert.equal(out.runs.length, 1)
  assert.equal(out.runs[0].isError, true, 'an unverified drop is distinguishable from a verified one')
})

test('parseRefutation refuses to read a verdict out of a non-boolean or a missing field', () => {
  assert.equal(parseRefutation('{"refuted":"false","why":"real bug"}').refuted, true, 'a string is not a verdict')
  assert.equal(parseRefutation('{"why":"real bug"}').refuted, true, 'no verdict field means no verdict')
  assert.equal(parseRefutation('').refuted, true)
  assert.equal(parseRefutation(undefined).refuted, true, 'a run with no result at all is not a survival')
  assert.equal(parseRefutation('{"refuted":false}').why, '', 'a missing reason is empty, never undefined')
  // Fenced and prose-wrapped JSON is still a verdict: refute-by-default must not
  // become refute-always, or the pass would be a no-op that drops everything.
  assert.equal(parseRefutation('```json\n{"refuted":false,"why":"real"}\n```').refuted, false)
  assert.equal(parseRefutation('After reading src/a.ts:\n{"refuted": false, "why": "real"}\nThat is my answer.').refuted, false)
})
