import { createSign } from 'node:crypto'

const API = 'https://api.github.com'
const b64url = (input) => Buffer.from(input).toString('base64url')

export function mintAppJwt({ appId, privateKeyPem, nowSeconds }) {
  const header = { alg: 'RS256', typ: 'JWT' }
  // iat backdated 60s for clock skew; exp well inside GitHub's 10-minute ceiling.
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem)
  return `${signingInput}.${b64url(signature)}`
}

function appHeaders(jwt) {
  return { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
}

export async function getInstallationToken({ appId, privateKeyPem, installationId, nowSeconds, fetchImpl = fetch }) {
  const jwt = mintAppJwt({ appId, privateKeyPem, nowSeconds })
  const res = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: appHeaders(jwt),
  })
  if (!res.ok) throw new Error(`Installation token request failed (${res.status}): ${await res.text()}`)
  const body = await res.json()
  return { token: body.token, expiresAt: body.expires_at }
}

export async function getBotLogin({ appId, privateKeyPem, nowSeconds, fetchImpl = fetch }) {
  const jwt = mintAppJwt({ appId, privateKeyPem, nowSeconds })
  const res = await fetchImpl(`${API}/app`, { headers: appHeaders(jwt) })
  if (!res.ok) throw new Error(`Could not read app metadata (${res.status}): ${await res.text()}`)
  const { slug } = await res.json()
  return `${slug}[bot]`
}
