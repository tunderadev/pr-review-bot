import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { mintAppJwt, getInstallationToken, getBotLogin } from '../src/github-auth.mjs'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const NOW = 1_800_000_000

test('mintAppJwt produces a verifiable RS256 JWT with GitHub-required claims', () => {
  const jwt = mintAppJwt({ appId: 12345, privateKeyPem: privateKey, nowSeconds: NOW })
  const [h, p, s] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' })
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString())
  assert.equal(payload.iss, '12345')
  assert.equal(payload.iat, NOW - 60, 'iat is backdated to tolerate clock skew')
  // Comparing exp to iat is vacuous: iat is itself backdated 60s, so an exp
  // already in the past still clears it. The token must outlive NOW.
  assert.ok(payload.exp > NOW, 'token must not be born expired')
  assert.ok(payload.exp - NOW <= 600, 'exp must be within GitHub 10-minute ceiling')
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')))
})

test('getInstallationToken exchanges the JWT for an installation token', async () => {
  const calls = []
  const permissions = { pull_requests: 'write', issues: 'write', contents: 'read' }
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 201, json: async () => ({ token: 'ghs_abc', expires_at: '2026-07-29T19:00:00Z', permissions }) }
  }
  const out = await getInstallationToken({ appId: 1, privateKeyPem: privateKey, installationId: 99, nowSeconds: NOW, fetchImpl })
  assert.deepEqual(out, { token: 'ghs_abc', expiresAt: '2026-07-29T19:00:00Z', permissions })
  assert.equal(calls[0].url, 'https://api.github.com/app/installations/99/access_tokens')
  assert.equal(calls[0].init.method, 'POST')
  assert.match(calls[0].init.headers.authorization, /^Bearer eyJ/)
})

test('getInstallationToken returns the granted permissions, which doctor reads to predict a 422', async () => {
  // The under-privileged case is the one worth pinning: a read-only grant is
  // indistinguishable from a write grant until the review POST is rejected,
  // which is after a full model review has been bought.
  const fetchImpl = async () => ({
    ok: true,
    status: 201,
    json: async () => ({ token: 'ghs_abc', expires_at: '2026-07-29T19:00:00Z', permissions: { pull_requests: 'read', contents: 'read' } }),
  })
  const out = await getInstallationToken({ appId: 1, privateKeyPem: privateKey, installationId: 99, nowSeconds: NOW, fetchImpl })
  assert.deepEqual(out.permissions, { pull_requests: 'read', contents: 'read' })
})

test('getInstallationToken does not invent permissions a response never carried', async () => {
  // An empty object would read downstream as a real answer of "grants
  // nothing"; undefined is what makes doctor say the grant is unverified.
  const fetchImpl = async () => ({ ok: true, status: 201, json: async () => ({ token: 'ghs_abc', expires_at: '2026-07-29T19:00:00Z' }) })
  const out = await getInstallationToken({ appId: 1, privateKeyPem: privateKey, installationId: 99, nowSeconds: NOW, fetchImpl })
  assert.equal(out.permissions, undefined)
})

test('getInstallationToken surfaces a readable error on failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'bad key' })
  await assert.rejects(
    getInstallationToken({ appId: 1, privateKeyPem: privateKey, installationId: 99, nowSeconds: NOW, fetchImpl }),
    /401.*bad key/s
  )
})

test('getBotLogin derives the [bot] login from the app slug', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ slug: 'plat-reviewer' }) })
  assert.equal(await getBotLogin({ appId: 1, privateKeyPem: privateKey, nowSeconds: NOW, fetchImpl }), 'plat-reviewer[bot]')
})

test('getBotLogin refuses a 200 response with no slug', async () => {
  // "undefined[bot]" matches no author, so findSticky and alreadyReviewedSha
  // would fail forever: a fresh sticky comment and a duplicate review per cycle.
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: 42 }) })
  await assert.rejects(getBotLogin({ appId: 1, privateKeyPem: privateKey, nowSeconds: NOW, fetchImpl }), /slug/)
})

test('mintAppJwt coerces a numeric-string nowSeconds instead of concatenating it', () => {
  const jwt = mintAppJwt({ appId: 1, privateKeyPem: privateKey, nowSeconds: String(NOW) })
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
  assert.equal(payload.iat, NOW - 60)
  assert.equal(payload.exp, NOW + 540, 'string + 540 concatenates to a timestamp ~57,000 years out')
})

test('mintAppJwt rejects a nowSeconds that is not a finite number', () => {
  for (const nowSeconds of [undefined, null, NaN, Infinity, 'not-a-number', {}]) {
    assert.throws(() => mintAppJwt({ appId: 1, privateKeyPem: privateKey, nowSeconds }), /nowSeconds/, `accepted ${String(nowSeconds)}`)
  }
})
