import {
  constants,
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
  type JsonWebKey
} from 'node:crypto'
import {
  AUTH_AUTHORIZATION_ENDPOINT,
  AUTH_CALLBACK,
  AUTH_CLIENT_ID,
  AUTH_ISSUER,
  AUTH_ORIGIN,
  AuthRequestError,
  type AuthCredentials,
  type AuthPending
} from './contracts'

const MAX_RESPONSE_BYTES = 128 * 1024
const MAX_ACCESS_LIFETIME_SECONDS = 30 * 24 * 60 * 60
const REQUEST_TIMEOUT_MS = 12_000
const opaque = /^[A-Za-z0-9_-]{43}$/

interface OidcDependencies {
  getClientSecret(): Promise<string>
  fetch?: typeof globalThis.fetch
  now?: () => number
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthRequestError('identity-invalid')
  }
  return value as Record<string, unknown>
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new AuthRequestError('identity-invalid')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new AuthRequestError('identity-invalid')
  return bytes
}

function jwtObject(value: string): Record<string, unknown> {
  try {
    return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(value))))
  } catch {
    throw new AuthRequestError('identity-invalid')
  }
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function identityId(subject: string): string {
  return `whmcs:${createHash('sha256').update(`${AUTH_ISSUER}\0${subject}`).digest('hex')}`
}

function profileUser(profile: Record<string, unknown>): KoalaAuthUser {
  if (typeof profile.sub !== 'string' || !profile.sub || profile.sub.length > 255) {
    throw new AuthRequestError('identity-invalid')
  }
  const user: KoalaAuthUser = { id: identityId(profile.sub) }
  if (typeof profile.name === 'string' && profile.name.length > 0 && profile.name.length <= 256) {
    user.name = profile.name
  }
  if (
    typeof profile.email === 'string' &&
    profile.email.length > 0 &&
    profile.email.length <= 320
  ) {
    user.email = profile.email
  }
  return user
}

function validatePending(pending: AuthPending, now: number): void {
  if (
    !opaque.test(pending.state) ||
    !opaque.test(pending.nonce) ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(pending.codeVerifier) ||
    !Number.isSafeInteger(pending.expiresAt)
  ) {
    throw new AuthRequestError('invalid-callback')
  }
  if (pending.expiresAt <= now) throw new AuthRequestError('login-expired')
}

/** Native WHMCS OIDC. Credentials and verification remain in the Electron main process. */
export function createWhmcsOidc(deps: OidcDependencies) {
  const fetch = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? Date.now

  const clientSecret = async (): Promise<string> => {
    try {
      const secret = await deps.getClientSecret()
      if (
        typeof secret !== 'string' ||
        !secret.trim() ||
        secret.length > 8192 ||
        Array.from(secret).some((character) => {
          const point = character.charCodeAt(0)
          return point < 32 || point === 127
        })
      ) {
        throw new Error('Missing runtime credential')
      }
      return secret
    } catch {
      throw new AuthRequestError('configuration-error')
    }
  }

  const request = async (
    kind: 'token' | 'keys' | 'profile',
    init: RequestInit = {}
  ): Promise<Record<string, unknown>> => {
    const paths = {
      token: '/oauth/token.php',
      keys: '/oauth/certs.php',
      profile: '/oauth/userinfo.php'
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(new URL(paths[kind], AUTH_ORIGIN), {
        ...init,
        headers: { Accept: 'application/json', ...init.headers },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal
      })
      const declaredSize = Number(response.headers.get('content-length') ?? 0)
      if (declaredSize > MAX_RESPONSE_BYTES) {
        await response.body?.cancel()
        throw new AuthRequestError('server-error')
      }
      const reader = response.body?.getReader()
      if (!reader) throw new AuthRequestError('server-error')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel()
            throw new AuthRequestError('server-error')
          }
          chunks.push(chunk.value)
        }
      } finally {
        reader.releaseLock()
      }
      let value: Record<string, unknown>
      try {
        value = object(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
        )
      } catch {
        throw new AuthRequestError('server-error')
      }
      if (!response.ok) {
        if (kind === 'token' && value.error === 'invalid_client') {
          throw new AuthRequestError('configuration-error')
        }
        if (kind === 'token' && (response.status === 400 || response.status === 401)) {
          throw new AuthRequestError('identity-invalid')
        }
        if (kind === 'profile' && (response.status === 401 || response.status === 403)) {
          throw new AuthRequestError('session-expired')
        }
        throw new AuthRequestError('server-error')
      }
      return value
    } catch (error) {
      if (error instanceof AuthRequestError) throw error
      // Fetch exceptions can include request URLs or provider text. Never expose them to the UI.
      throw new AuthRequestError('network-error')
    } finally {
      clearTimeout(timer)
    }
  }

  const verifyIdentity = async (
    token: string,
    expectedNonce: string,
    accessToken: string
  ): Promise<Record<string, unknown>> => {
    if (token.length > 16384) throw new AuthRequestError('identity-invalid')
    const parts = token.split('.')
    if (parts.length !== 3) throw new AuthRequestError('identity-invalid')
    const [head, body, signed] = parts
    const header = jwtObject(head)
    const claims = jwtObject(body)
    const signature = decode(signed)
    if (
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string' ||
      !header.kid ||
      header.kid.length > 255 ||
      ['crit', 'b64', 'jku', 'jwk', 'x5u'].some((key) => key in header)
    ) {
      throw new AuthRequestError('identity-invalid')
    }
    const jwks = await request('keys')
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 32) {
      throw new AuthRequestError('identity-invalid')
    }
    const matches = jwks.keys.filter(
      (key) => key && typeof key === 'object' && !Array.isArray(key) && key.kid === header.kid
    )
    if (matches.length !== 1) throw new AuthRequestError('identity-invalid')
    const jwk = object(matches[0])
    if (
      jwk.kty !== 'RSA' ||
      (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
      (jwk.use !== undefined && jwk.use !== 'sig') ||
      ['d', 'p', 'q', 'dp', 'dq', 'qi'].some((field) => field in jwk) ||
      (jwk.key_ops !== undefined &&
        (!Array.isArray(jwk.key_ops) ||
          !jwk.key_ops.every((operation) => typeof operation === 'string') ||
          !jwk.key_ops.includes('verify'))) ||
      typeof jwk.n !== 'string' ||
      typeof jwk.e !== 'string' ||
      jwk.n.length > 1400 ||
      jwk.e.length > 12
    ) {
      throw new AuthRequestError('identity-invalid')
    }
    decode(jwk.n)
    decode(jwk.e)
    try {
      const publicKey = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' })
      const bits = publicKey.asymmetricKeyDetails?.modulusLength ?? 0
      if (
        publicKey.asymmetricKeyType !== 'rsa' ||
        bits < 2048 ||
        bits > 8192 ||
        signature.length !== Math.ceil(bits / 8) ||
        !verify(
          'RSA-SHA256',
          Buffer.from(`${head}.${body}`),
          { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
          signature
        )
      ) {
        throw new Error('Invalid signature')
      }
    } catch {
      throw new AuthRequestError('identity-invalid')
    }
    const seconds = Math.floor(now() / 1000)
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud
    if (
      claims.iss !== AUTH_ISSUER ||
      !Array.isArray(audiences) ||
      !audiences.every((audience) => typeof audience === 'string') ||
      !audiences.includes(AUTH_CLIENT_ID) ||
      (audiences.length > 1 && claims.azp !== AUTH_CLIENT_ID) ||
      (claims.azp !== undefined && claims.azp !== AUTH_CLIENT_ID) ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      claims.sub.length > 255 ||
      typeof claims.exp !== 'number' ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= seconds ||
      typeof claims.iat !== 'number' ||
      !Number.isSafeInteger(claims.iat) ||
      claims.iat > seconds + 30 ||
      claims.iat < seconds - 600 ||
      claims.exp <= claims.iat ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== 'number' ||
          !Number.isSafeInteger(claims.nbf) ||
          claims.nbf > seconds + 30)) ||
      typeof claims.nonce !== 'string' ||
      !equal(claims.nonce, expectedNonce)
    ) {
      throw new AuthRequestError('identity-invalid')
    }
    if (
      claims.at_hash !== undefined &&
      (typeof claims.at_hash !== 'string' ||
        !equal(
          claims.at_hash,
          createHash('sha256').update(accessToken).digest().subarray(0, 16).toString('base64url')
        ))
    ) {
      throw new AuthRequestError('identity-invalid')
    }
    return claims
  }

  const userinfo = (token: string): Promise<Record<string, unknown>> =>
    request('profile', { headers: { Authorization: `Bearer ${token}` } })

  return {
    async prepareLogin(): Promise<void> {
      await clientSecret()
    },

    authorizationUrl(pending: AuthPending): string {
      validatePending(pending, now())
      const url = new URL(AUTH_AUTHORIZATION_ENDPOINT)
      url.search = new URLSearchParams({
        client_id: AUTH_CLIENT_ID,
        response_type: 'code',
        scope: 'openid profile email',
        redirect_uri: AUTH_CALLBACK,
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: createHash('sha256').update(pending.codeVerifier).digest('base64url'),
        code_challenge_method: 'S256'
      }).toString()
      return url.toString()
    },

    async exchange(code: string, pending: AuthPending): Promise<AuthCredentials> {
      validatePending(pending, now())
      if (typeof code !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(code)) {
        throw new AuthRequestError('invalid-callback')
      }
      const secret = await clientSecret()
      const started = now()
      const data = await request('token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: AUTH_CLIENT_ID,
          client_secret: secret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: AUTH_CALLBACK,
          code_verifier: pending.codeVerifier
        }).toString()
      })
      if (
        typeof data.id_token !== 'string' ||
        !data.id_token ||
        typeof data.access_token !== 'string' ||
        !/^[\x21-\x7e]{1,8192}$/.test(data.access_token) ||
        typeof data.token_type !== 'string' ||
        data.token_type.toLowerCase() !== 'bearer' ||
        typeof data.expires_in !== 'number' ||
        !Number.isSafeInteger(data.expires_in) ||
        data.expires_in <= 0 ||
        data.expires_in > MAX_ACCESS_LIFETIME_SECONDS
      ) {
        throw new AuthRequestError('identity-invalid')
      }
      const claims = await verifyIdentity(data.id_token, pending.nonce, data.access_token)
      const profile = await userinfo(data.access_token)
      if (typeof profile.sub !== 'string' || !equal(profile.sub, claims.sub as string)) {
        throw new AuthRequestError('identity-invalid')
      }
      const expiresAt = started + data.expires_in * 1000
      if (expiresAt <= now()) throw new AuthRequestError('session-expired')
      return {
        accessToken: data.access_token,
        idToken: data.id_token,
        expiresAt,
        user: profileUser(profile)
      }
    },

    async restore(credentials: AuthCredentials): Promise<AuthCredentials> {
      if (!Number.isSafeInteger(credentials.expiresAt) || credentials.expiresAt <= now()) {
        throw new AuthRequestError('session-expired')
      }
      if (
        !credentials.user ||
        typeof credentials.user.id !== 'string' ||
        typeof credentials.accessToken !== 'string' ||
        !/^[\x21-\x7e]{1,8192}$/.test(credentials.accessToken)
      ) {
        throw new AuthRequestError('identity-invalid')
      }
      const user = profileUser(await userinfo(credentials.accessToken))
      if (!equal(user.id, credentials.user.id)) throw new AuthRequestError('identity-invalid')
      if (credentials.expiresAt <= now()) throw new AuthRequestError('session-expired')
      return {
        accessToken: credentials.accessToken,
        ...(credentials.idToken && { idToken: credentials.idToken }),
        expiresAt: credentials.expiresAt,
        user
      }
    }
  }
}
