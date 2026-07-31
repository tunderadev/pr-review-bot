import { createSign } from 'node:crypto'

const API = 'https://api.github.com'
const b64url = (input) => Buffer.from(input).toString('base64url')

export function mintAppJwt({ appId, privateKeyPem, nowSeconds }) {
  // Coerced explicitly: a string "1800000000" subtracts fine but concatenates
  // on +, so exp would land ~57,000 years out and GitHub would reject the JWT.
  // Number(null) and Number([]) are 0 — finite, and a silent 1970 timestamp —
  // so the accepted shapes are narrowed before coercion.
  const numeric = typeof nowSeconds === 'number' || (typeof nowSeconds === 'string' && nowSeconds.trim() !== '')
  const now = numeric ? Number(nowSeconds) : NaN
  if (!Number.isFinite(now)) throw new Error(`mintAppJwt requires a finite numeric nowSeconds, got ${JSON.stringify(nowSeconds) ?? String(nowSeconds)}`)
  const header = { alg: 'RS256', typ: 'JWT' }
  // iat backdated 60s for clock skew; exp well inside GitHub's 10-minute ceiling.
  const payload = { iat: now - 60, exp: now + 540, iss: String(appId) }
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
  // A missing slug would yield "undefined[bot]", which matches no author:
  // findSticky and alreadyReviewedSha would then fail silently, forever.
  if (typeof slug !== 'string' || !slug) throw new Error('GET /app returned no "slug"; cannot derive the bot login')
  return `${slug}[bot]`
}
