// Read-only live check; never submits a password, client secret or authorization code.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { AUTH_ORIGIN, AUTH_ISSUER } = require('../src/main/auth/contracts.ts')
const { createWhmcsOidc } = require('../src/main/auth/oidc.ts')
const { createAuthSession } = require('../src/main/auth/session.ts')

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Standalone JavaScript script.
async function read(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Koala-OIDC-Check/1.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000)
  })
  assert.equal(response.status, 200, `${new URL(url).pathname}: HTTP ${response.status}`)
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 524_288) {
      await reader.cancel()
      throw new Error('Response too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

let loginUrl
let stage = 'discovery'
const session = createAuthSession({
  store: { load: async () => null, save: async () => false },
  provider: createWhmcsOidc({
    // prepareLogin only: the fixture is never sent to WHMCS.
    getClientSecret: async () => 'unused-public-endpoint-check',
    fetch: async () => {
      throw new Error('This check must not exchange credentials')
    }
  }),
  openBrowser: async (url) => {
    loginUrl = new URL(url)
  },
  onChange: () => {}
})

try {
  const discovery = JSON.parse(await read(new URL('/oauth/openid-configuration.php', AUTH_ORIGIN)))
  assert.equal(discovery.issuer, AUTH_ISSUER)
  await session.login()
  assert.ok(loginUrl)
  assert.equal(loginUrl.searchParams.get('response_type'), 'code')
  stage = 'authorization page'
  const page = await read(loginUrl)
  assert.match(page, /<title>Login - Coolgo Network<\/title>/i)
  const formActions = [...page.matchAll(/<form\b[^>]*\baction=["']([^"']+)["'][^>]*>/gi)].map(
    ([, action]) => new URL(action.replaceAll('&amp;', '&'), loginUrl)
  )
  const loginAction = formActions.find((url) => url.pathname.endsWith('/dologin.php'))
  assert.ok(loginAction, 'WHMCS login form is present')
  assert.equal(
    loginAction.origin,
    loginUrl.origin,
    'Browser authorization and the login form must share an origin to preserve the WHMCS session'
  )
  assert.equal(
    `${loginUrl.origin}${loginUrl.pathname}`,
    discovery.authorization_endpoint,
    'Browser authorization must use the endpoint published by WHMCS'
  )
  stage = 'public keys'
  const jwks = JSON.parse(await read(new URL('/oauth/certs.php', AUTH_ORIGIN)))
  assert.ok(jwks.keys.some((key) => key.kty === 'RSA'))
  console.log('PASS discovery, authorization URL, same-origin login form and RSA keys.')
  console.log(`Authorization: ${loginUrl.origin}${loginUrl.pathname}`)
  console.log(
    'Public login page verified. Actual account login and token exchange still need verification.'
  )
} catch (error) {
  // Never print the generated URL, provider bodies or callback information.
  console.error(
    error instanceof assert.AssertionError ? error.message : `Public endpoint check failed at ${stage}.`
  )
  process.exitCode = 1
} finally {
  session.dispose()
}
