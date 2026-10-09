import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  AUTH_AUTHORIZATION_ENDPOINT,
  AUTH_CALLBACK,
  AUTH_CLIENT_ID,
  AUTH_ISSUER,
  AUTH_ORIGIN
} from '../src/main/auth/contracts'
import { createWhmcsOidc } from '../src/main/auth/oidc'
import { createSecureAuthStore } from '../src/main/auth/secure-store'
import { createAuthSession } from '../src/main/auth/session'

test('direct login joins browser callback, real JWT verification, encrypted persistence and live restoration', async (t) => {
  const now = 1_800_000_000_000
  const directory = await mkdtemp(join(tmpdir(), 'koala-direct-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'session.enc')
  const encryptedValues = new Map<string, string>()
  let encryptionChecks = 0
  let encryptions = 0
  let available = true
  let decryptionDenied = false
  const store = createSecureAuthStore(filePath, {
    isAvailable: () => {
      encryptionChecks++
      return available
    },
    encrypt: (value) => {
      encryptions++
      const key = randomBytes(48)
      encryptedValues.set(key.toString('hex'), value)
      return key
    },
    decrypt: (key) => {
      if (decryptionDenied) throw new Error('Simulated keychain refusal')
      return encryptedValues.get(key.toString('hex'))!
    }
  })
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'integration-key', use: 'sig' }
  const clientSecret = 'fixture-only-client-secret'
  const accessToken = 'fixture-only-access-token'
  const code = '4/native+authorization/code=' // Exercises the native code format across both layers.
  let browserUrl: URL
  const requests: string[] = []
  const provider = createWhmcsOidc({
    now: () => now,
    getClientSecret: async () => clientSecret,
    fetch: async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.origin, AUTH_ORIGIN)
      assert.equal(init?.redirect, 'error')
      requests.push(url.pathname)
      let data: unknown
      if (url.pathname === '/oauth/token.php') {
        assert.equal(init?.method, 'POST')
        assert.equal(
          new Headers(init.headers).get('content-type'),
          'application/x-www-form-urlencoded'
        )
        const form = new URLSearchParams(String(init.body))
        assert.equal(form.get('client_secret'), clientSecret)
        assert.equal(form.get('client_id'), AUTH_CLIENT_ID)
        assert.equal(form.get('code'), code)
        assert.equal(form.get('redirect_uri'), AUTH_CALLBACK)
        assert.equal(form.get('code_verifier'), (await store.load())?.pending?.codeVerifier)
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString(
          'base64url'
        )
        const claims = Buffer.from(
          JSON.stringify({
            iss: AUTH_ISSUER,
            aud: AUTH_CLIENT_ID,
            sub: 'whmcs-opaque-subject',
            nonce: browserUrl.searchParams.get('nonce'),
            iat: now / 1000,
            exp: now / 1000 + 120
          })
        ).toString('base64url')
        const payload = `${header}.${claims}`
        data = {
          id_token: `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`,
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600
        }
      } else if (url.pathname === '/oauth/certs.php') {
        data = { keys: [jwk] }
      } else {
        assert.equal(url.pathname, '/oauth/userinfo.php')
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${accessToken}`)
        data = { sub: 'whmcs-opaque-subject', name: 'Customer' }
      }
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    }
  })
  const publicStates: KoalaAuthState[] = []
  const session = createAuthSession({
    now: () => now,
    store,
    provider,
    openBrowser: async (url) => {
      browserUrl = new URL(url)
    },
    onChange: (state) => publicStates.push(state)
  })
  t.after(session.dispose)
  await session.login()
  assert.equal(`${browserUrl!.origin}${browserUrl!.pathname}`, AUTH_AUTHORIZATION_ENDPOINT)
  const callback = new URL(AUTH_CALLBACK)
  callback.search = new URLSearchParams({
    code,
    state: browserUrl!.searchParams.get('state')!
  }).toString()
  await session.acceptCallback(callback.toString())
  assert.equal((await session.getState()).status, 'signed-in')
  assert.deepEqual(requests, ['/oauth/token.php', '/oauth/certs.php', '/oauth/userinfo.php'])
  const envelope = await readFile(filePath, 'utf8')
  const idToken = (await store.load())?.session?.idToken
  assert.match(idToken!, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.equal((await session.serviceSession()).idToken, idToken)
  for (const secret of [clientSecret, accessToken, idToken!]) {
    assert.ok(!envelope.includes(secret))
    assert.ok(!JSON.stringify(publicStates).includes(secret))
  }
  const restarted = createAuthSession({
    now: () => now,
    store,
    provider,
    openBrowser: async () => assert.fail('Restoring must not launch another browser'),
    onChange: (state) => publicStates.push(state)
  })
  t.after(restarted.dispose)
  const initialChecks = encryptionChecks
  const initialRequests = requests.length
  const initialEncryptions = encryptions
  await restarted.getState()
  await restarted.getState()
  assert.equal(encryptionChecks, initialChecks, 'startup and focus must not access the keychain')
  assert.equal(requests.length, initialRequests)
  for (const deniedByAvailability of [true, false]) {
    available = !deniedByAvailability
    decryptionDenied = !deniedByAvailability
    assert.equal((await restarted.restoreSession()).error, 'storage-error')
    assert.equal(await readFile(filePath, 'utf8'), envelope, 'denial preserves the encrypted vault')
    assert.equal(requests.length, initialRequests, 'an unreadable vault never reaches WHMCS')
    const deniedChecks = encryptionChecks
    await restarted.getState()
    assert.equal(encryptionChecks, deniedChecks, 'focus cannot repeat a declined prompt')
  }
  decryptionDenied = false
  assert.equal((await restarted.restoreSession()).user?.name, 'Customer')
  assert.equal(encryptions, initialEncryptions, 'restore does not encrypt the existing vault again')
  assert.equal(await readFile(filePath, 'utf8'), envelope)
  assert.equal((await restarted.serviceSession()).idToken, idToken)
  assert.equal(requests.at(-1), '/oauth/userinfo.php')
  const requestCount = requests.length
  const checksBeforeLogout = encryptionChecks
  available = false
  await restarted.logout()
  assert.equal(encryptionChecks, checksBeforeLogout, 'logout deletes without keychain access')
  assert.equal(await store.load(), null)
  assert.equal(
    requests.length,
    requestCount,
    'Logout clears locally without inventing a remote endpoint'
  )
})
