import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { test } from 'node:test'
import {
  AUTH_AUTHORIZATION_ENDPOINT,
  AUTH_CALLBACK,
  AUTH_CLIENT_ID,
  AUTH_ISSUER,
  AUTH_ORIGIN,
  AuthRequestError,
  type AuthPending
} from '../src/main/auth/contracts'
import { createWhmcsOidc } from '../src/main/auth/oidc'

const current = generateKeyPairSync('rsa', { modulusLength: 2048 })
const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 })
const weak = generateKeyPairSync('rsa', { modulusLength: 1024 })
const instant = 1_800_000_000_000
const secret = 'test-runtime-secret+/=never-real'
const access = 'provider-access-token+/='
const opaque = (): string => randomBytes(32).toString('base64url')

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function fixture() {
  let clock = instant
  const pending: AuthPending = {
    state: opaque(),
    nonce: opaque(),
    codeVerifier: opaque(),
    expiresAt: instant + 600_000
  }
  const options = {
    secret,
    secretError: false,
    claims: {} as Record<string, unknown>,
    header: {} as Record<string, unknown>,
    token: {} as Record<string, unknown>,
    profile: { sub: 'subject-001', name: '测试用户', email: 'user@example.test' } as Record<
      string,
      unknown
    >,
    omitNonce: false,
    corruptSignature: false,
    rotate: false,
    weakKey: false,
    keys: undefined as unknown,
    jwt: undefined as string | undefined,
    respond: undefined as
      | ((path: string, init: RequestInit) => Response | Promise<Response>)
      | undefined
  }
  const calls: { url: URL; init: RequestInit }[] = []
  const provider = createWhmcsOidc({
    now: () => clock,
    getClientSecret: async () => {
      if (options.secretError) throw new Error(`OS error includes ${secret}`)
      return options.secret
    },
    fetch: (async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      calls.push({ url, init })
      assert.equal(url.origin, AUTH_ORIGIN)
      assert.equal(init.redirect, 'error')
      assert.equal(init.credentials, 'omit')
      assert.equal(init.cache, 'no-store')
      assert.ok(init.signal instanceof AbortSignal)
      if (options.respond) return options.respond(url.pathname, init)
      if (url.pathname === '/oauth/token.php') {
        const claims = {
          iss: AUTH_ISSUER,
          aud: AUTH_CLIENT_ID,
          sub: 'subject-001',
          iat: Math.floor(clock / 1000),
          exp: Math.floor(clock / 1000) + 300,
          nonce: pending.nonce,
          ...options.claims
        }
        if (options.omitNonce) delete (claims as Record<string, unknown>).nonce
        const key = options.weakKey ? weak : options.rotate ? rotated : current
        const header = { alg: 'RS256', kid: options.rotate ? 'next' : 'current', ...options.header }
        const content = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(
          JSON.stringify(claims)
        ).toString('base64url')}`
        const signature = sign('RSA-SHA256', Buffer.from(content), key.privateKey)
        if (options.corruptSignature) signature[0] ^= 1
        return json({
          access_token: access,
          id_token: options.jwt ?? `${content}.${signature.toString('base64url')}`,
          expires_in: 3600,
          token_type: 'Bearer',
          ...options.token
        })
      }
      if (url.pathname === '/oauth/certs.php') {
        return json({
          keys: options.keys ?? [
            {
              ...(options.weakKey ? weak : current).publicKey.export({ format: 'jwk' }),
              kid: 'current',
              alg: 'RS256',
              use: 'sig'
            },
            {
              ...rotated.publicKey.export({ format: 'jwk' }),
              kid: 'next',
              alg: 'RS256',
              use: 'sig'
            }
          ]
        })
      }
      assert.equal(url.pathname, '/oauth/userinfo.php')
      assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${access}`)
      return json(options.profile)
    }) as typeof fetch
  })
  return {
    provider,
    pending,
    options,
    calls,
    setClock: (time: number) => (clock = time),
    exchange: (code = 'native/authorization+code=') => provider.exchange(code, pending)
  }
}

async function rejected(promise: Promise<unknown>, reason: KoalaAuthError): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AuthRequestError)
    assert.equal(error.reason, reason)
    assert.equal(error.message, reason)
    assert.ok(!String(error).includes(secret))
    return true
  })
}

test('native authorization URL uses the registered custom callback and never contains secrets', async () => {
  const f = fixture()
  await f.provider.prepareLogin()
  assert.equal(f.calls.length, 0)
  const url = new URL(f.provider.authorizationUrl(f.pending))
  assert.equal(`${url.origin}${url.pathname}`, AUTH_AUTHORIZATION_ENDPOINT)
  assert.equal(url.origin, 'https://www.coolgo.network')
  assert.equal(url.pathname, '/oauth/authorize.php')
  assert.equal(url.searchParams.get('redirect_uri'), AUTH_CALLBACK)
  assert.equal(url.searchParams.get('client_id'), AUTH_CLIENT_ID)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('scope'), 'openid profile email')
  assert.equal(url.searchParams.get('state'), f.pending.state)
  assert.equal(url.searchParams.get('nonce'), f.pending.nonce)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(f.pending.codeVerifier).digest('base64url')
  )
  assert.ok(!url.toString().includes(f.pending.codeVerifier))
  assert.ok(!url.toString().includes(secret))
  assert.equal(url.searchParams.has('client_secret'), false)
})

test('runtime credential is required before browser login and errors never expose its value', async () => {
  for (const value of ['', '   ', 'x'.repeat(8193), 'bad\nsecret']) {
    const f = fixture()
    f.options.secret = value
    await rejected(f.provider.prepareLogin(), 'configuration-error')
    assert.equal(f.calls.length, 0)
  }
  const f = fixture()
  f.options.secretError = true
  await rejected(f.provider.prepareLogin(), 'configuration-error')
})

test('browser authorization follows the published session host while API requests retain the configured access host', async () => {
  const f = fixture()
  const browser = new URL(f.provider.authorizationUrl(f.pending))
  assert.equal(
    `${browser.origin}${browser.pathname}`,
    'https://www.coolgo.network/oauth/authorize.php'
  )
  await f.exchange()
  assert.deepEqual(
    f.calls.map((call) => call.url.toString()),
    [
      'https://whmcs.coolgo.network/oauth/token.php',
      'https://whmcs.coolgo.network/oauth/certs.php',
      'https://whmcs.coolgo.network/oauth/userinfo.php'
    ]
  )
})

test('exchange sends the secret only in a form POST, verifies identity, and needs no refresh token', async () => {
  const f = fixture()
  const credentials = await f.exchange()
  assert.deepEqual(
    f.calls.map((call) => call.url.pathname),
    ['/oauth/token.php', '/oauth/certs.php', '/oauth/userinfo.php']
  )
  const first = f.calls[0]
  assert.equal(first.init.method, 'POST')
  assert.equal(
    new Headers(first.init.headers).get('Content-Type'),
    'application/x-www-form-urlencoded'
  )
  const form = new URLSearchParams(String(first.init.body))
  assert.equal(form.get('client_secret'), secret)
  assert.equal(form.get('client_id'), AUTH_CLIENT_ID)
  assert.equal(form.get('redirect_uri'), AUTH_CALLBACK)
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('code'), 'native/authorization+code=')
  assert.equal(form.get('code_verifier'), f.pending.codeVerifier)
  assert.ok(f.calls.every((call) => !call.url.toString().includes(secret)))
  assert.equal(credentials.accessToken, access)
  assert.equal(credentials.expiresAt, instant + 3_600_000)
  assert.equal(
    credentials.user.id,
    `whmcs:${createHash('sha256').update(`${AUTH_ISSUER}\0subject-001`).digest('hex')}`
  )
  assert.equal(credentials.user.name, '测试用户')
  assert.equal(credentials.user.email, 'user@example.test')
  assert.deepEqual(Object.keys(credentials).sort(), ['accessToken', 'expiresAt', 'idToken', 'user'])
  assert.match(credentials.idToken!, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.ok(!JSON.stringify(credentials).includes(secret))
})

test('authorization codes are native strings, bounded and never accepted with whitespace', async () => {
  const boundary = fixture()
  await boundary.exchange('/'.repeat(4096))
  for (const code of ['', 'bad code', 'bad\ncode', 'x'.repeat(4097), '非ASCII']) {
    const f = fixture()
    await rejected(f.exchange(code), 'invalid-callback')
    assert.equal(f.calls.length, 0)
  }
})

test('expired or malformed local pending state cannot exchange a code', async () => {
  const f = fixture()
  f.setClock(f.pending.expiresAt)
  await rejected(f.exchange(), 'login-expired')
  assert.equal(f.calls.length, 0)
  const bad = fixture()
  bad.pending.nonce = 'short'
  await rejected(bad.exchange(), 'invalid-callback')
})

const invalidClaims: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ['missing nonce', (f) => (f.options.omitNonce = true)],
  ['foreign nonce', (f) => (f.options.claims.nonce = opaque())],
  ['wrong issuer', (f) => (f.options.claims.iss = AUTH_ORIGIN)],
  ['wrong audience', (f) => (f.options.claims.aud = 'another-client')],
  ['multiple audiences without azp', (f) => (f.options.claims.aud = [AUTH_CLIENT_ID, 'other'])],
  ['wrong azp', (f) => (f.options.claims.azp = 'other')],
  ['expired token', (f) => (f.options.claims.exp = instant / 1000)],
  ['future issued-at', (f) => (f.options.claims.iat = instant / 1000 + 31)],
  ['stale issued-at', (f) => (f.options.claims.iat = instant / 1000 - 601)],
  ['future not-before', (f) => (f.options.claims.nbf = instant / 1000 + 31)],
  ['string expiry', (f) => (f.options.claims.exp = String(instant / 1000 + 300))],
  ['empty subject', (f) => (f.options.claims.sub = '')],
  ['bad access token hash', (f) => (f.options.claims.at_hash = opaque())],
  ['tampered signature', (f) => (f.options.corruptSignature = true)],
  ['unsigned algorithm', (f) => (f.options.header.alg = 'none')],
  ['HMAC confusion', (f) => (f.options.header.alg = 'HS256')],
  ['unknown key ID', (f) => (f.options.header.kid = 'missing')],
  ['small RSA key', (f) => (f.options.weakKey = true)],
  ['key URL injection', (f) => (f.options.header.jku = 'https://evil.example.test/keys')],
  [
    'inline key injection',
    (f) => (f.options.header.jwk = current.publicKey.export({ format: 'jwk' }))
  ],
  ['critical header', (f) => (f.options.header.crit = ['custom'])],
  ['unknown JWT encoding', (f) => (f.options.header.b64 = false)],
  ['malformed JWT', (f) => (f.options.jwt = 'abc.def.ghi.extra')]
]
for (const [name, modify] of invalidClaims) {
  test(`rejects ${name} before calling userinfo`, async () => {
    const f = fixture()
    modify(f)
    await rejected(f.exchange(), 'identity-invalid')
    assert.ok(f.calls.every((call) => call.url.pathname !== '/oauth/userinfo.php'))
  })
}

test('JWKS rejects duplicate key IDs, private/symmetric keys and prohibited key usage', async () => {
  const publicJwk = { ...current.publicKey.export({ format: 'jwk' }), kid: 'current' }
  for (const keys of [
    [publicJwk, publicJwk],
    [{ ...publicJwk, kty: 'oct' }],
    [{ ...publicJwk, alg: 'HS256' }],
    [{ ...publicJwk, use: 'enc' }],
    [{ ...publicJwk, key_ops: ['encrypt'] }],
    [{ ...current.privateKey.export({ format: 'jwk' }), kid: 'current' }],
    [{ ...publicJwk, n: 'non-canonical=' }]
  ]) {
    const f = fixture()
    f.options.keys = keys
    await rejected(f.exchange(), 'identity-invalid')
    assert.ok(f.calls.every((call) => call.url.pathname !== '/oauth/userinfo.php'))
  }
})

test('valid key rotation, authorized multiple audiences, and access token hash are accepted', async () => {
  const f = fixture()
  f.options.rotate = true
  f.options.claims.aud = [AUTH_CLIENT_ID, 'other']
  f.options.claims.azp = AUTH_CLIENT_ID
  f.options.claims.at_hash = createHash('sha256')
    .update(access)
    .digest()
    .subarray(0, 16)
    .toString('base64url')
  await f.exchange()
})

test('userinfo subject must match the verified ID token subject exactly', async () => {
  const f = fixture()
  f.options.profile.sub = 'another-subject'
  await rejected(f.exchange(), 'identity-invalid')
})

test('optional profile fields can be absent or oversized without corrupting the credentials', async () => {
  const f = fixture()
  f.options.profile = { sub: 'subject-001', name: 'x'.repeat(257), email: 'x'.repeat(321) }
  assert.deepEqual(Object.keys((await f.exchange()).user), ['id'])
  f.options.profile = { sub: 'subject-001' }
  assert.deepEqual(Object.keys((await f.exchange()).user), ['id'])
})

test('token response validates all required token and expiration fields', async () => {
  for (const token of [
    { id_token: '' },
    { access_token: '' },
    { access_token: 'bad\r\nheader' },
    { token_type: 'Basic' },
    { expires_in: undefined },
    { expires_in: '3600' },
    { expires_in: 0 },
    { expires_in: -1 },
    { expires_in: 1.5 },
    { expires_in: 30 * 86400 + 1 }
  ]) {
    const f = fixture()
    f.options.token = token
    await rejected(f.exchange(), 'identity-invalid')
    assert.equal(f.calls.length, 1)
  }
})

test('restore checks live userinfo and existing identity without needing a client secret', async () => {
  const f = fixture()
  const credentials = await f.exchange()
  f.calls.length = 0
  f.options.secretError = true
  f.options.profile.name = 'Updated name'
  const restored = await f.provider.restore(credentials)
  assert.equal(restored.user.name, 'Updated name')
  assert.equal(restored.expiresAt, credentials.expiresAt)
  assert.equal(restored.idToken, credentials.idToken)
  assert.deepEqual(
    f.calls.map((call) => call.url.pathname),
    ['/oauth/userinfo.php']
  )
  f.options.profile.sub = 'different-account'
  await rejected(f.provider.restore(credentials), 'identity-invalid')
})

test('restore refuses local expiry and malformed access tokens before network access', async () => {
  const f = fixture()
  const credentials = await f.exchange()
  f.calls.length = 0
  await rejected(
    f.provider.restore({ ...credentials, accessToken: 'bad\nheader' }),
    'identity-invalid'
  )
  assert.equal(f.calls.length, 0)
  f.setClock(credentials.expiresAt)
  await rejected(f.provider.restore(credentials), 'session-expired')
  assert.equal(f.calls.length, 0)
})

test('HTTP errors are mapped to fixed reasons without exposing provider bodies or secrets', async () => {
  for (const [status, error, expected] of [
    [400, 'invalid_client', 'configuration-error'],
    [400, 'invalid_grant', 'identity-invalid'],
    [500, 'server_error', 'server-error']
  ] as const) {
    const f = fixture()
    f.options.respond = () => json({ error, error_description: `private ${secret}` }, status)
    await rejected(f.exchange(), expected)
  }
  const f = fixture()
  f.options.respond = () => {
    throw new Error(`request failed containing ${secret}`)
  }
  await rejected(f.exchange(), 'network-error')
  const expired = fixture()
  const credentials = await expired.exchange()
  expired.options.respond = () => json({ error: 'private token information' }, 401)
  await rejected(expired.provider.restore(credentials), 'session-expired')
})

test('provider responses are bounded even without Content-Length and malformed JSON is hidden', async () => {
  for (const respond of [
    () => new Response('{}', { headers: { 'Content-Length': String(128 * 1024 + 1) } }),
    () => new Response('x'.repeat(128 * 1024 + 1)),
    () => new Response(`not-json ${secret}`),
    () => json([])
  ]) {
    const f = fixture()
    f.options.respond = respond
    await rejected(f.exchange(), 'server-error')
  }
})

test('the request deadline aborts a stalled provider with a controlled error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  let requested!: () => void
  const started = new Promise<void>((resolve) => (requested = resolve))
  f.options.respond = (_path, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error(`private ${secret}`)), {
        once: true
      })
      requested()
    })
  const attempt = f.exchange()
  await started
  const outcome = rejected(attempt, 'network-error')
  t.mock.timers.tick(12_000)
  await outcome
  assert.equal(f.calls.length, 1)
})

test('restore cannot revive a token that expires while userinfo is in flight', async () => {
  const f = fixture()
  const credentials = await f.exchange()
  f.options.respond = () => {
    f.setClock(credentials.expiresAt)
    return json(f.options.profile)
  }
  await rejected(f.provider.restore(credentials), 'session-expired')
})
