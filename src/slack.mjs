export class SlackError extends Error {}

const API = 'https://slack.com/api'

// Reaction reconciliation is idempotent by design: every round removes the
// previous state emoji and adds the new one, so re-adding one that is already
// there and removing one that is not are the normal steady state, not
// failures. Throwing on either would abort a review cycle over a no-op.
const BENIGN = new Set(['already_reacted', 'no_reaction'])

export function createSlack({ token, fetchImpl = fetch }) {
  async function call(method, body) {
    const res = await fetchImpl(`${API}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
    // Slack reports failure inside a 200 response. Checking res.ok here would
    // read every not_in_channel, invalid_auth and channel_not_found as a
    // success; the verdict is the body's `ok` field, never the HTTP status.
    const data = await res.json()
    if (!data.ok && !BENIGN.has(data.error)) throw new SlackError(`Slack ${method} failed: ${data.error}`)
    return data
  }

  return {
    // The returned ts is durable state: it is written into the PR's sticky
    // comment and every later thread reply and reaction on that PR is
    // addressed to it, so returning the wrong field breaks the binding
    // permanently and silently.
    async postMessage({ channel, text, blocks }) {
      const data = await call('chat.postMessage', { channel, text, ...(blocks ? { blocks } : {}), unfurl_links: false })
      return { ts: data.ts }
    },
    postThreadReply: ({ channel, threadTs, text }) => call('chat.postMessage', { channel, thread_ts: threadTs, text, unfurl_links: false }),
    // Slack names the message id `timestamp` on the reactions methods and `ts`
    // on chat.postMessage; the caller only ever holds the `ts` it was given.
    addReaction: ({ channel, ts, name }) => call('reactions.add', { channel, timestamp: ts, name }),
    removeReaction: ({ channel, ts, name }) => call('reactions.remove', { channel, timestamp: ts, name }),
    async lookupUserByEmail(email) {
      const data = await call('users.lookupByEmail', { email })
      return data.user?.id
    },
  }
}
