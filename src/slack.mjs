export class SlackError extends Error {}

const API = 'https://slack.com/api'

// Reaction reconciliation is idempotent by design: every round removes the
// previous state emoji and adds the new one, so re-adding one that is already
// there and removing one that is not are the normal steady state, not
// failures. Throwing on either would abort a review cycle over a no-op.
//
// Tolerated by the REACTION methods only. Applied to every method, a
// chat.postMessage that answered already_reacted was read as a success and
// returned {ts: undefined} — and that ts is written into the sticky comment as
// the PR's durable Slack binding, so every later thread reply and reaction on
// that PR would be addressed to nothing, silently and permanently.
const BENIGN_REACTION_ERRORS = new Set(['already_reacted', 'no_reaction'])
const NOTHING = new Set()

// A form is flat, so structured arguments (blocks) travel as JSON strings —
// which is what Slack expects on a form-encoded request — and booleans as
// "true"/"false". Absent optional arguments are dropped rather than sent as
// the literal strings "undefined"/"null", which Slack would try to parse.
function encodeForm(params) {
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  return form.toString()
}

export function createSlack({ token, fetchImpl = fetch }) {
  async function call(method, params, { tolerate = NOTHING } = {}) {
    const res = await fetchImpl(`${API}/${method}`, {
      method: 'POST',
      // Form-encoded, never JSON: EVERY Slack Web API method accepts
      // application/x-www-form-urlencoded, while only some accept JSON.
      // users.lookupByEmail is one that does not — it answers
      // invalid_arguments to a JSON body — so this is the one transport that
      // works for all of them.
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: encodeForm(params),
    })
    // A proxy, a 502 page or a truncated response can put anything on the
    // wire. Reading .ok off it raised a raw TypeError, which escapes the
    // SlackError callers catch and is not a TransientError either — so a bad
    // gateway landed as the sticky review-error label that is never
    // auto-retried.
    let data
    try {
      data = await res.json()
    } catch (cause) {
      throw new SlackError(`Slack ${method} returned a body that is not JSON (HTTP ${res.status})`, { cause })
    }
    if (!data || typeof data !== 'object') {
      throw new SlackError(`Slack ${method} returned a body that is not an object (HTTP ${res.status})`)
    }
    // Slack reports failure inside a 200 response. Checking res.ok here would
    // read every not_in_channel, invalid_auth and channel_not_found as a
    // success; the verdict is the body's `ok` field, never the HTTP status.
    if (!data.ok && !tolerate.has(data.error)) throw new SlackError(`Slack ${method} failed: ${data.error}`)
    return data
  }

  const reaction = (method, { channel, ts, name }) =>
    // Slack names the message id `timestamp` on the reactions methods and `ts`
    // on chat.postMessage; the caller only ever holds the `ts` it was given.
    call(method, { channel, timestamp: ts, name }, { tolerate: BENIGN_REACTION_ERRORS })

  return {
    // The returned ts is durable state: it is written into the PR's sticky
    // comment and every later thread reply and reaction on that PR is
    // addressed to it, so returning the wrong field breaks the binding
    // permanently and silently.
    async postMessage({ channel, text, blocks }) {
      // No conditional spread for `blocks`: encodeForm already drops absent
      // arguments, and two mechanisms for one job means only one of them is
      // ever exercised.
      const data = await call('chat.postMessage', { channel, text, blocks, unfurl_links: false })
      return { ts: data.ts }
    },
    postThreadReply: ({ channel, threadTs, text }) => call('chat.postMessage', { channel, thread_ts: threadTs, text, unfurl_links: false }),
    addReaction: (args) => reaction('reactions.add', args),
    removeReaction: (args) => reaction('reactions.remove', args),
    async lookupUserByEmail(email) {
      const data = await call('users.lookupByEmail', { email })
      return data.user?.id
    },
  }
}
