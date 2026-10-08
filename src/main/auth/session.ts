import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  AuthRequestError,
  isIdentityToken,
  type AuthCredentials,
  type AuthPending,
  type AuthProvider,
  type AuthVault
} from './contracts'
import { ServiceRequestError, type ServiceSession } from './services'

export { AUTH_ORIGIN, AUTH_CALLBACK, AuthRequestError } from './contracts'
export type { AuthCredentials, AuthPending, AuthProvider, AuthVault } from './contracts'

const LOGIN_LIFETIME = 10 * 60 * 1000
const printableToken = /^[\x21-\x7e]+$/

interface AuthDependencies {
  store: {
    load(): Promise<AuthVault | null>
    save(vault: AuthVault): Promise<boolean>
  }
  provider: AuthProvider
  openBrowser(url: string): Promise<void>
  onChange(state: KoalaAuthState): void
  now?: () => number
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function checkedCredentials(value: AuthCredentials, now: number): AuthCredentials {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.accessToken !== 'string' ||
    value.accessToken.length > 8192 ||
    !printableToken.test(value.accessToken) ||
    (value.idToken !== undefined && !isIdentityToken(value.idToken)) ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= now ||
    !value.user ||
    typeof value.user.id !== 'string' ||
    !value.user.id ||
    value.user.id.length > 1024 ||
    (value.user.name !== undefined &&
      (typeof value.user.name !== 'string' || value.user.name.length > 256)) ||
    (value.user.email !== undefined &&
      (typeof value.user.email !== 'string' || value.user.email.length > 320))
  )
    throw new AuthRequestError('server-error')
  return {
    accessToken: value.accessToken,
    ...(value.idToken && { idToken: value.idToken }),
    expiresAt: value.expiresAt,
    user: { id: value.user.id, name: value.user.name, email: value.user.email }
  }
}

/** Only the provider and encrypted main-process store receive credentials. */
export function createAuthSession(deps: AuthDependencies) {
  const now = deps.now ?? Date.now
  let view: KoalaAuthState = { status: 'signed-out', persistence: 'none' }
  let pending: AuthPending | undefined
  let credentials: AuthCredentials | undefined
  let generation = 0
  let loadPromise: Promise<void> | undefined
  let loading = false
  let preparing = false
  let exchangingState: string | undefined
  let reopenSequence = 0
  let writeQueue: Promise<unknown> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined

  const snapshot = (): KoalaAuthState => ({ ...view, ...(view.user && { user: { ...view.user } }) })
  const publish = (next: KoalaAuthState): void => {
    view = next
    deps.onChange(snapshot())
  }
  const stopTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const reason = (error: unknown): KoalaAuthError =>
    error instanceof AuthRequestError ? error.reason : 'server-error'
  const save = async (): Promise<boolean> => {
    const vault: AuthVault = {
      version: 2,
      ...(pending && { pending: { ...pending } }),
      ...(credentials && { session: { ...credentials, user: { ...credentials.user } } })
    }
    const task = writeQueue.then(() => deps.store.save(vault))
    writeQueue = task.catch(() => undefined)
    return task
  }

  function schedule(): void {
    stopTimer()
    const deadline = pending?.expiresAt ?? credentials?.expiresAt
    if (deadline === undefined) return
    timer = setTimeout(
      () => {
        timer = undefined
        void getState().then(() => {
          if (!timer && (pending || credentials)) schedule()
        })
      },
      Math.min(2_147_483_647, Math.max(1, deadline - now()))
    )
    timer.unref?.()
  }

  async function clear(error: KoalaAuthError | undefined, epoch: number): Promise<void> {
    if (epoch !== generation) return
    pending = undefined
    credentials = undefined
    stopTimer()
    try {
      await save()
    } catch {
      error = 'storage-error'
    }
    if (epoch === generation)
      publish({ status: 'signed-out', persistence: 'none', ...(error && { error }) })
  }

  async function adopt(next: AuthCredentials, epoch: number): Promise<void> {
    if (epoch !== generation) return
    credentials = checkedCredentials(next, now())
    pending = undefined
    let encrypted = false
    let error: KoalaAuthError | undefined
    try {
      encrypted = await save()
    } catch {
      error = 'storage-error'
    }
    if (epoch !== generation) return
    if (next.expiresAt <= now()) {
      await clear('session-expired', epoch)
      return
    }
    publish({
      status: 'signed-in',
      user: { ...credentials.user },
      persistence: encrypted ? 'encrypted' : 'memory',
      ...(error && { error })
    })
    schedule()
  }

  async function load(): Promise<void> {
    if (!loadPromise) {
      const epoch = generation
      loading = true
      loadPromise = (async () => {
        let vault: AuthVault | null
        try {
          vault = await deps.store.load()
        } catch {
          await clear('storage-error', epoch)
          return
        }
        if (epoch !== generation) return
        if (vault?.pending) {
          pending = vault.pending
          if (pending.expiresAt <= now()) await clear('login-expired', epoch)
          else {
            publish({ status: 'signing-in', persistence: 'none' })
            schedule()
          }
        } else if (vault?.session) {
          if (vault.session.expiresAt <= now()) {
            await clear('session-expired', epoch)
            return
          }
          try {
            const restored = await deps.provider.restore(vault.session)
            await adopt(restored, epoch)
          } catch (error) {
            await clear(reason(error), epoch)
          }
        }
      })().finally(() => {
        if (epoch === generation) loading = false
      })
    }
    await loadPromise
  }

  async function getState(): Promise<KoalaAuthState> {
    await load()
    if (pending && pending.expiresAt <= now()) await clear('login-expired', ++generation)
    else if (credentials && credentials.expiresAt <= now())
      await clear('session-expired', ++generation)
    return snapshot()
  }

  async function serviceSession(): Promise<ServiceSession> {
    await getState()
    const current = credentials
    const epoch = generation
    if (view.status !== 'signed-in' || !current || current.expiresAt <= now())
      throw new ServiceRequestError('not-signed-in')
    return {
      identity: current.user.id,
      accessToken: current.accessToken,
      ...(current.idToken && { idToken: current.idToken }),
      assertCurrent: () => {
        if (
          epoch !== generation ||
          credentials !== current ||
          view.status !== 'signed-in' ||
          current.expiresAt <= now()
        )
          throw new ServiceRequestError('session-changed')
      }
    }
  }

  async function startLogin(): Promise<KoalaAuthState> {
    if (credentials && credentials.expiresAt > now()) return snapshot()
    const epoch = ++generation
    pending = undefined
    credentials = undefined
    stopTimer()
    preparing = true
    publish({ status: 'signing-in', persistence: 'none' })
    try {
      await deps.provider.prepareLogin()
      if (epoch !== generation) return snapshot()
      const attempt: AuthPending = {
        state: randomBytes(32).toString('base64url'),
        codeVerifier: randomBytes(32).toString('base64url'),
        nonce: randomBytes(32).toString('base64url'),
        expiresAt: now() + LOGIN_LIFETIME
      }
      pending = attempt
      try {
        await save()
      } catch {
        /* This attempt can continue without persistence. */
      }
      if (epoch !== generation) return snapshot()
      const url = deps.provider.authorizationUrl(attempt)
      schedule()
      try {
        await deps.openBrowser(url)
      } catch (error) {
        throw error instanceof AuthRequestError
          ? error
          : new AuthRequestError('browser-open-failed')
      }
    } catch (error) {
      await clear(reason(error), epoch)
    } finally {
      if (epoch === generation) preparing = false
    }
    return snapshot()
  }

  async function login(): Promise<KoalaAuthState> {
    const epoch = generation
    await load()
    if (epoch !== generation) return snapshot()
    return startLogin()
  }

  async function reopenLogin(): Promise<KoalaAuthState> {
    const initialEpoch = generation
    await load()
    if (initialEpoch !== generation) return snapshot()
    const attempt = pending
    if (exchangingState && (!attempt || exchangingState === attempt.state)) return snapshot()
    if (!attempt || attempt.expiresAt <= now()) return startLogin()
    const epoch = generation
    const opening = ++reopenSequence
    const current = (): boolean =>
      epoch === generation &&
      opening === reopenSequence &&
      pending?.state === attempt.state &&
      exchangingState !== attempt.state
    publish({ status: 'signing-in', persistence: 'none' })
    try {
      await deps.provider.prepareLogin()
      if (!current()) return snapshot()
      const url = deps.provider.authorizationUrl(attempt)
      try {
        await deps.openBrowser(url)
      } catch (error) {
        throw error instanceof AuthRequestError
          ? error
          : new AuthRequestError('browser-open-failed')
      }
    } catch (error) {
      if (current()) publish({ status: 'signing-in', persistence: 'none', error: reason(error) })
    }
    return snapshot()
  }

  async function logout(): Promise<KoalaAuthState> {
    const epoch = ++generation
    // Invalidate an in-flight startup restore before waiting on any I/O. Future
    // operations need not wait for that obsolete provider response either.
    loadPromise = Promise.resolve()
    loading = false
    preparing = false
    pending = undefined
    credentials = undefined
    stopTimer()
    publish({ status: 'signed-out', persistence: 'none' })
    await clear(undefined, epoch)
    return snapshot()
  }

  async function cancelLogin(): Promise<KoalaAuthState> {
    if (!pending && !exchangingState && !loading && !preparing) return snapshot()
    return logout()
  }

  async function acceptCallback(raw: string): Promise<boolean> {
    let url: URL
    try {
      if (
        raw.length > 32_768 ||
        [...raw].some(
          (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
        )
      )
        return false
      url = new URL(raw)
    } catch {
      return false
    }
    if (url.protocol !== 'koala-clash:' || url.hostname !== 'auth') return false
    await load()
    const attempt = pending
    if (!attempt || exchangingState === attempt.state) return true
    if (!equal(url.searchParams.get('state') ?? '', attempt.state)) return true
    const epoch = generation
    const allowed = new Set(['state', 'code', 'error', 'error_description', 'error_uri'])
    const code = url.searchParams.get('code')
    const providerError = url.searchParams.get('error')
    const malformed =
      url.pathname !== '/callback' ||
      !!url.port ||
      !!url.username ||
      !!url.password ||
      !!url.hash ||
      [...url.searchParams.keys()].some(
        (key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1
      ) ||
      ['error_description', 'error_uri'].some(
        (key) => (url.searchParams.get(key)?.length ?? 0) > 2048
      )
    let error: KoalaAuthError | undefined
    if (attempt.expiresAt <= now()) error = 'login-expired'
    else if (
      malformed ||
      (url.searchParams.has('code') && url.searchParams.has('error')) ||
      (providerError !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(providerError))
    )
      error = 'invalid-callback'
    else if (providerError !== null)
      error = providerError === 'access_denied' ? 'access-denied' : 'server-error'
    else if (!code || code.length > 4096 || !printableToken.test(code)) error = 'invalid-callback'
    if (!error && code) {
      exchangingState = attempt.state
      try {
        const result = await deps.provider.exchange(code, { ...attempt })
        await adopt(result, epoch)
        return true
      } catch (cause) {
        error = reason(cause)
      } finally {
        if (exchangingState === attempt.state) exchangingState = undefined
      }
    }
    await clear(error ?? 'server-error', epoch)
    return true
  }

  return {
    getState,
    login,
    reopenLogin,
    logout,
    cancelLogin,
    acceptCallback,
    serviceSession,
    dispose: stopTimer
  }
}
