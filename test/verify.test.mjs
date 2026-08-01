import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { buildRefutationPrompt, parseRefutation, refuteBlockers, MAX_REFUTATIONS } from '../src/verify.mjs'

const PR = { repo: 'o/r', number: 7, headSha: 'abc1234' }
const blocking = (claim) => ({ severity: 'blocking', file: 'src/a.ts', line: 1, claim, why: 'w' })
// A run the CLI reports as failed: the refutation never happened, whatever the
// text says.
const errorRun = (text) => ({ result: text, is_error: true, subtype: 'error_during_execution', usage: {}, total_cost_usd: 0, duration_ms: 1 })

function fakeSpawn(results) {
  const calls = []
  const killed = []
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter()
    const call = { cmd, args, cwd: opts?.cwd, prompt: '' }
    calls.push(call)
    child.stdin = new Writable({ write(c, e, cb) { call.prompt += c; cb() }, final(cb) { cb() } })
    const result = results.shift()
    // A string is a successful answer; an object is a whole envelope, so a test
    // can produce a run the CLI itself failed on.
    const envelope = result !== null && typeof result === 'object'
      ? result
      : { result, is_error: false, usage: {}, total_cost_usd: 0, duration_ms: 1, subtype: 'success' }
    child.stdout = Readable.from([JSON.stringify(envelope)])
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
  const prose = 'Yes, this is definitely a real bug and it must be fixed before merge.'
  const impl = fakeSpawn([prose, prose])
  const out = await refuteBlockers({ findings: [blocking('real')], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.deepEqual(out.survivors, [], 'no verdict is not a surviving verdict')
  assert.deepEqual(out.refuted.map((f) => f.claim), ['real'])
  assert.equal(out.runs.length, 2, 'one unreadable answer earns a retry before the finding is dropped')
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

// --- `degraded`: was a blocker dropped because the model cleared it, or because
// the refutation never happened? Zero survivors means an approval downstream, so
// the two cases must not look alike.

test('a pass where every blocker timed out is degraded, not a clean bill of health', async () => {
  const impl = fakeSpawn([null, null])
  const out = await refuteBlockers({ findings: [blocking('a'), blocking('b')], pr: PR, cwd: '/wt', spawnImpl: impl, timeoutMs: 25 })
  assert.deepEqual(out.survivors, [])
  assert.equal(out.degraded, true, 'nothing was checked; this must not read as approval')
  assert.deepEqual(out.refuted.map((f) => f.claim), ['a', 'b'])
  assert.deepEqual(out.refuted.map((f) => f.unverified), [true, true])
})

test('a pass where every refutation errored out is degraded', async () => {
  // The quota wall is the realistic one: it arrives mid-pass and has nothing to
  // do with whether the findings are real.
  const impl = fakeSpawn([errorRun('Claude AI usage limit reached'), errorRun('Claude AI usage limit reached')])
  const out = await refuteBlockers({ findings: [blocking('a'), blocking('b')], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.deepEqual(out.survivors, [])
  assert.equal(out.degraded, true)
  assert.deepEqual(out.refuted.map((f) => f.unverified), [true, true])
  assert.deepEqual(out.runs.map((r) => r.isError), [true, true])
})

test('a model that never honours the response contract is degraded, not merely uncertain', async () => {
  // Two failures of a strict, restated contract is not a considered judgment
  // about the finding — it is the contract not being honoured, which means no
  // answer was obtained. Filing it as a refutation on the merits is what lets a
  // regressed or misconfigured model quietly approve a PR full of real defects.
  const impl = fakeSpawn(['I could not find a path to that failure, honestly.', 'Seems fine? Hard to say.', 'Nope.', 'Still nope.'])
  const out = await refuteBlockers({ findings: [blocking('a'), blocking('b')], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.deepEqual(out.survivors, [])
  assert.deepEqual(out.refuted.map((f) => f.claim), ['a', 'b'])
  assert.equal(out.degraded, true)
  assert.deepEqual(out.refuted.map((f) => f.unverified), [true, true])
  assert.equal(impl.calls.length, 4, 'two attempts per finding, no more')
})

test('one unreadable answer then a real verdict is a refutation on the merits', async () => {
  // The discriminating case for `degraded`. A single unparseable response is
  // plausibly a formatting slip; the model got a second chance and used it, so
  // this is a genuine verdict and the pass is not degraded.
  const impl = fakeSpawn(['Hmm, let me think about that.', '{"refuted":true,"why":"guarded upstream"}'])
  const out = await refuteBlockers({ findings: [blocking('bogus')], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.deepEqual(out.survivors, [])
  assert.deepEqual(out.refuted.map((f) => f.claim), ['bogus'])
  assert.deepEqual(out.refuted.map((f) => f.unverified), [false], 'the model answered on the second ask')
  assert.equal(out.degraded, false, 'a slip that the retry fixed is not a degraded pass')
  assert.equal(out.refuted[0].refutation, 'guarded upstream')
  assert.equal(out.runs.length, 2, 'both attempts are reported: the retry cost real quota')
})

test('the retry restates the contract, and there is exactly one of them', async () => {
  const impl = fakeSpawn(['prose one', 'prose two', 'prose three', 'prose four'])
  await refuteBlockers({ findings: [blocking('real')], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.equal(impl.calls.length, 2, 'one retry, not a loop')
  const [first, retry] = impl.calls.map((c) => c.prompt)
  assert.notEqual(retry, first, 'resending the identical prompt is not a retry')
  assert.ok(retry.startsWith(first), 'the retry keeps the original question')
  const added = retry.slice(first.length)
  assert.match(added, /not valid JSON/i, 'the retry names the failure')
  assert.match(added, /"refuted"/, 'and restates the contract it wants honoured')
})

test('a parseable first answer is never asked twice', async () => {
  // The retry is only for a broken contract. Paying for a second child on every
  // finding would double the cost of the whole pass.
  const impl = fakeSpawn(['{"refuted":true,"why":"guarded"}', '{"refuted":false,"why":"unused"}'])
  const out = await refuteBlockers({ findings: [blocking('bogus')], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.equal(impl.calls.length, 1, 'a good answer is not second-guessed')
  assert.equal(out.runs.length, 1)
  assert.deepEqual(out.refuted.map((f) => f.unverified), [false])
  assert.equal(out.degraded, false)
})

test('an errored first attempt is not retried, and is degraded either way', async () => {
  // A quota wall is not beaten by asking again a second later; the retry exists
  // for a formatting slip, not for infrastructure.
  const impl = fakeSpawn([errorRun('Claude AI usage limit reached'), '{"refuted":false,"why":"unused"}'])
  const out = await refuteBlockers({ findings: [blocking('real')], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.equal(impl.calls.length, 1, 'no second call into a wall')
  assert.deepEqual(out.refuted.map((f) => f.unverified), [true])
  assert.equal(out.degraded, true)
})

test('a timeout on either attempt lands as unverified, never as a refutation on the merits', async () => {
  // First attempt hangs: no retry, because the budget is per finding and a
  // wedged child has already spent it.
  const early = fakeSpawn([null, '{"refuted":true,"why":"unused"}'])
  const outEarly = await refuteBlockers({ findings: [blocking('a')], pr: PR, cwd: '/wt', spawnImpl: early, timeoutMs: 25 })
  assert.equal(early.calls.length, 1, 'a timed-out finding is not re-asked')
  assert.deepEqual(outEarly.refuted.map((f) => f.unverified), [true])
  assert.equal(outEarly.degraded, true)

  // Unreadable first, then the retry hangs: still unverified, never merits.
  const late = fakeSpawn(['prose, sorry', null])
  const outLate = await refuteBlockers({ findings: [blocking('b')], pr: PR, cwd: '/wt', spawnImpl: late, timeoutMs: 25 })
  assert.equal(late.calls.length, 2)
  assert.deepEqual(outLate.survivors, [])
  assert.deepEqual(outLate.refuted.map((f) => f.unverified), [true])
  assert.equal(outLate.degraded, true)
  assert.match(outLate.refuted[0].refutation, /timed out/i)
  assert.equal(outLate.runs.length, 2, 'both the wasted answer and the wedged retry are reported')
  assert.deepEqual(late.killed, ['SIGKILL'])
})

test('one genuine refutation plus one timeout is degraded', async () => {
  const impl = fakeSpawn(['{"refuted":true,"why":"guarded upstream"}', null])
  const out = await refuteBlockers({ findings: [blocking('cleared'), blocking('never checked')], pr: PR, cwd: '/wt', spawnImpl: impl, timeoutMs: 25 })
  assert.equal(out.degraded, true, 'one unchecked blocker is enough to make an approval unsafe')
  assert.deepEqual(out.refuted.map((f) => f.claim), ['cleared', 'never checked'])
  assert.deepEqual(out.refuted.map((f) => f.unverified), [false, true], 'per finding, not per pass')
  assert.equal(out.refuted[0].refutation, 'guarded upstream')
  assert.match(out.refuted[1].refutation, /not verified/i, 'Task 12 renders these; the two must not read alike')
})

test('a pass where every refutation returned a real verdict is not degraded', async () => {
  const impl = fakeSpawn(['{"refuted":false,"why":"traced it"}', '{"refuted":true,"why":"guarded"}'])
  const out = await refuteBlockers({ findings: [blocking('real'), blocking('bogus')], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.deepEqual(out.survivors.map((f) => f.claim), ['real'])
  assert.deepEqual(out.refuted.map((f) => f.claim), ['bogus'])
  assert.equal(out.degraded, false, 'a working pass must never look degraded, or the flag gets ignored')
  assert.deepEqual(out.refuted.map((f) => f.unverified), [false])
})

test('zero blocking findings is not a degraded pass', async () => {
  // Nothing was dropped, so there is nothing unverified — and still no spawn.
  const impl = fakeSpawn([])
  const out = await refuteBlockers({ findings: [{ severity: 'nit', file: 'f', line: 1, claim: 'n', why: 'w' }], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.equal(out.degraded, false, 'the clean PR is the common case; it must not ask for a retry')
  assert.equal(impl.calls.length, 0)
  assert.deepEqual(out.survivors, [])
  assert.deepEqual(out.refuted, [])
})

test('an errored run cannot confirm a blocker any more than it can refute one', async () => {
  // A failed run whose text happens to parse is still not a verdict. Letting it
  // through would block a colleague on a claim nothing verified — and it would
  // do so with degraded false, so nothing downstream could tell.
  const impl = fakeSpawn([errorRun('{"refuted":false,"why":"looks real to me"}')])
  const out = await refuteBlockers({ findings: [blocking('real')], pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.deepEqual(out.survivors, [], 'a failed run must not put a finding in front of the author')
  assert.deepEqual(out.refuted.map((f) => f.unverified), [true])
  assert.equal(out.degraded, true)
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

// ---------------------------------------------------------------------------
// The fan-out cap
//
// Two calls per blocking finding, run serially, each with a five-minute budget.
// Measured before the cap existed: 2000 findings spawned 2000 children, and 100
// findings with one retry apiece spawned 200 — a worst case of over seventeen
// hours on one PR, drawn from the operator's personal subscription.
// ---------------------------------------------------------------------------

const answers = (n, text = '{"refuted":true,"why":"guarded upstream"}') => Array.from({ length: n }, () => text)
const manyBlockers = (n) => Array.from({ length: n }, (_, i) => blocking(`claim ${i}`))

test('the number of findings refuted per PR is capped', async () => {
  const impl = fakeSpawn(answers(200))
  await refuteBlockers({ findings: manyBlockers(200), pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.equal(impl.calls.length, MAX_REFUTATIONS, 'a review with 200 blockers must not spawn 200 children')
})

test('findings past the cap are reported as unverified, never dropped in silence', async () => {
  // Enough answers for EVERY finding, deliberately: run the fake out of them and
  // the uncapped findings come back unverified because nothing answered, which
  // is the same shape the cap produces and would pass this test on its own.
  const impl = fakeSpawn(answers(MAX_REFUTATIONS + 4))
  const out = await refuteBlockers({ findings: manyBlockers(MAX_REFUTATIONS + 4), pr: PR, cwd: '/wt', spawnImpl: impl })

  assert.equal(
    out.survivors.length + out.refuted.length,
    MAX_REFUTATIONS + 4,
    'every finding the review raised has to come out somewhere'
  )
  const uncapped = out.refuted.filter((f) => f.unverified)
  assert.equal(uncapped.length, 4)
  // The rendering layer prints this sentence into a public review body, so it
  // has to read as "nobody checked this", not as a refutation on the merits.
  for (const f of uncapped) assert.match(f.refutation, /not verified/i, f.refutation)
  assert.match(uncapped[0].refutation, new RegExp(String(MAX_REFUTATIONS)), 'and it has to say what the limit was')
  assert.deepEqual(uncapped.map((f) => f.claim), manyBlockers(MAX_REFUTATIONS + 4).slice(MAX_REFUTATIONS).map((f) => f.claim))
})

test('an unverified finding past the cap does not block the author', async () => {
  // Uncertainty must not block a PR: nothing looked at these, so putting them in
  // front of the author as blocking costs a round trip over claims that may well
  // be wrong. They are named in the review instead.
  const impl = fakeSpawn(answers(MAX_REFUTATIONS + 3, '{"refuted":false,"why":"confirmed"}'))
  const out = await refuteBlockers({ findings: manyBlockers(MAX_REFUTATIONS + 3), pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.equal(out.survivors.length, MAX_REFUTATIONS, 'only findings something actually judged may survive')
  assert.equal(out.survivors.some((f) => f.unverified), false)
})

test('a capped pass is degraded, so zero survivors can never become an approval', async () => {
  // The dangerous shape: every checked finding is refuted, and the unchecked
  // ones are invisible. Zero survivors reads identically to a clean review, and
  // approving a PR carrying blocking claims nobody looked at is the worst thing
  // this tool can do.
  const impl = fakeSpawn(answers(MAX_REFUTATIONS + 1))
  const out = await refuteBlockers({ findings: manyBlockers(MAX_REFUTATIONS + 1), pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.deepEqual(out.survivors, [])
  assert.equal(out.degraded, true, 'the caller must be told the verdict is unknown')
})

test('a review exactly at the cap is fully verified and not degraded', async () => {
  const impl = fakeSpawn(answers(MAX_REFUTATIONS))
  const out = await refuteBlockers({ findings: manyBlockers(MAX_REFUTATIONS), pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.equal(impl.calls.length, MAX_REFUTATIONS)
  assert.equal(out.degraded, false, 'an off-by-one here silently benches an ordinary PR')
  assert.equal(out.refuted.some((f) => f.unverified), false)
})

test('nits do not consume the cap', async () => {
  const nit = (i) => ({ severity: 'nit', file: 'f', line: 1, claim: `nit ${i}`, why: 'w' })
  const findings = [...Array.from({ length: 30 }, (_, i) => nit(i)), ...manyBlockers(3)]
  const impl = fakeSpawn(answers(3))
  const out = await refuteBlockers({ findings, pr: PR, cwd: '/wt', spawnImpl: impl })
  assert.equal(impl.calls.length, 3, 'nits are never verified, so they cannot crowd out a blocker')
  assert.equal(out.degraded, false)
})
