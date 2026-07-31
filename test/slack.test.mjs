import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSlack, SlackError } from '../src/slack.mjs'

// Slack signals failure with HTTP 200 and {ok:false,error}. The stub pins
// res.ok true on every response so a client that trusts res.ok reports every
// failure below as a success.
function stub(responses) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({
      url,
      body: JSON.parse(init.body),
      auth: init.headers.authorization,
      method: init.method,
      contentType: init.headers['content-type'],
    })
    return { ok: true, status: 200, json: async () => responses.shift() }
  }
  return { impl, calls }
}

test('postMessage returns the ts used for all later thread and reaction calls', async () => {
  const { impl, calls } = stub([{ ok: true, ts: '1712345678.123456' }])
  const out = await createSlack({ token: 'xoxb-' + 't', fetchImpl: impl }).postMessage({ channel: 'C1', text: 'hi' })
  assert.deepEqual(out, { ts: '1712345678.123456' })
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage')
  assert.equal(calls[0].auth, 'Bearer xoxb-t')
  assert.equal(calls[0].body.channel, 'C1')
  // Every method shares one transport, so pinning it once covers all of them.
  // Both of these ship green when broken: a GET with a body makes fetch throw
  // at the first live call, and a JSON body with no content-type is rejected
  // by Slack — neither is observable through a stub that only reads the body.
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].contentType, 'application/json; charset=utf-8')
})

test('postThreadReply targets the parent ts', async () => {
  const { impl, calls } = stub([{ ok: true, ts: '2' }])
  await createSlack({ token: 't', fetchImpl: impl }).postThreadReply({ channel: 'C1', threadTs: '1', text: 'changes requested' })
  // The endpoint is pinned as well as the field: a reply sent to
  // chat.postEphemeral would carry a correct thread_ts and vanish anyway.
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage')
  assert.equal(calls[0].body.thread_ts, '1')
})

test('already_reacted and no_reaction are treated as success', async () => {
  const { impl, calls } = stub([{ ok: false, error: 'already_reacted' }, { ok: false, error: 'no_reaction' }])
  const slack = createSlack({ token: 't', fetchImpl: impl })
  await assert.doesNotReject(slack.addReaction({ channel: 'C1', ts: '1', name: 'x' }))
  await assert.doesNotReject(slack.removeReaction({ channel: 'C1', ts: '1', name: 'x' }))
  // Not rejecting is also what a method that never issued a request would do,
  // so the calls themselves are pinned: endpoint, and the `timestamp` field
  // name Slack wants for the message id we call `ts` everywhere else.
  assert.deepEqual(calls.map((c) => c.url), ['https://slack.com/api/reactions.add', 'https://slack.com/api/reactions.remove'])
  assert.deepEqual(calls.map((c) => c.body.timestamp), ['1', '1'])
})

test('a non-benign reaction error still throws', async () => {
  // Reaction reconciliation runs every round, so the temptation is to make
  // reactions never throw. Only the two idempotency codes are benign.
  const { impl } = stub([{ ok: false, error: 'message_not_found' }])
  await assert.rejects(
    createSlack({ token: 't', fetchImpl: impl }).addReaction({ channel: 'C1', ts: '1', name: 'x' }),
    (e) => e instanceof SlackError && /message_not_found/.test(e.message)
  )
})

test('other Slack errors throw SlackError naming the error code', async () => {
  const { impl } = stub([{ ok: false, error: 'not_in_channel' }])
  await assert.rejects(createSlack({ token: 't', fetchImpl: impl }).postMessage({ channel: 'C1', text: 'hi' }), (e) => e instanceof SlackError && /not_in_channel/.test(e.message))
})

test('lookupUserByEmail returns the member id', async () => {
  const { impl, calls } = stub([{ ok: true, user: { id: 'U9' } }])
  assert.equal(await createSlack({ token: 't', fetchImpl: impl }).lookupUserByEmail('a@b.c'), 'U9')
  assert.equal(calls[0].url, 'https://slack.com/api/users.lookupByEmail')
  assert.equal(calls[0].body.email, 'a@b.c')
})
