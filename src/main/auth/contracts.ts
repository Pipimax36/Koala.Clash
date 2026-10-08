export const AUTH_ORIGIN = 'https://whmcs.coolgo.network'
// WHMCS publishes this browser endpoint and posts its login form to the same
// origin. Replacing its host loses the host-only browser session cookie.
export const AUTH_AUTHORIZATION_ENDPOINT = 'https://www.coolgo.network/oauth/authorize.php'
export const AUTH_CALLBACK = 'koala-clash://auth/callback'
export const AUTH_CLIENT_ID = 'COOLGO-NETWORK.e1e6af03fe1090cd698d47a3b3096701'
// This is the identity published by WHMCS discovery, not an HTTP destination.
export const AUTH_ISSUER = 'https://www.coolgo.network'

export interface AuthPending {
  state: string
  codeVerifier: string
  nonce: string
  expiresAt: number
}

export interface AuthCredentials {
  accessToken: string
  /** Verified provider proof retained only in the encrypted main-process vault. */
  idToken?: string
  expiresAt: number
  user: KoalaAuthUser
}

export function isIdentityToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 16_384 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  )
}

export interface AuthVault {
  version: 2
  pending?: AuthPending
  session?: AuthCredentials
}

export interface AuthProvider {
  prepareLogin(): Promise<void>
  authorizationUrl(pending: AuthPending): string
  exchange(code: string, pending: AuthPending): Promise<AuthCredentials>
  restore(credentials: AuthCredentials): Promise<AuthCredentials>
}

export class AuthRequestError extends Error {
  constructor(public readonly reason: KoalaAuthError) {
    super(reason)
  }
}
