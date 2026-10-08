/** Replaced only in the Electron main bundle; never exposed to renderer code. */
declare const __KOALA_WHMCS_CLIENT_SECRET__: string | undefined

interface KoalaAuthUser {
  /** OIDC identity, not a WHMCS client/account ID. */
  id: string
  name?: string
  email?: string
}

type KoalaAuthError =
  | 'browser-open-failed'
  | 'protocol-unavailable'
  | 'protocol-conflict'
  | 'login-expired'
  | 'invalid-callback'
  | 'access-denied'
  | 'network-error'
  | 'configuration-error'
  | 'identity-invalid'
  | 'session-expired'
  | 'server-error'
  | 'storage-error'

interface KoalaAuthState {
  status: 'signed-out' | 'signing-in' | 'signed-in'
  user?: KoalaAuthUser
  persistence: 'none' | 'encrypted' | 'memory'
  error?: KoalaAuthError
}
