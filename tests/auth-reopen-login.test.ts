import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AuthRequestError,
  createAuthSession,
  type AuthCredentials,
  type AuthVault
} from '../src/main/auth/session'

const startTime = 1_800_000_000_000
const grant = 'g'.repeat(43)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function fixture() {
  let clock = startTime
  let vault: AuthVault | null = null
  let saves = 0
  let open = async (): Promise<void> => {}
  const issued = (): AuthCredentials => ({
    accessToken: 'a'.repeat(43),
    expiresAt: clock + 900_000,
    user: { id: 'test-user' }
  })
  let exchange = async (): Promise<AuthCredentials> => issued()
  const urls: string[] = []
  const changes: KoalaAuthState[] = []
  const app = createAuthSession({
    now: () => clock,
    store: {
      load: async () => vault,
      save: async (next) => {
        saves++
        vault = structuredClone(next)
        return true
      }
    },
    provider: {
      prepareLogin: async () => {},
      authorizationUrl: (pending) =>
        `https://whmcs.coolgo.network/oauth/authorize.php?state=${pending.state}&nonce=${pending.nonce}`,
      exchange: () => exchange(),
      restore: async (value) => value
    },
    openBrowser: async (url) => {
      urls.push(url)
      await open()
    },
    onChange: (state) => changes.push(state)
  })
  return {
    app,
    urls,
    changes,
    issued,
    vault: () => vault,
    saves: () => saves,
    clock: (value: number) => {
      clock = value
    },
    browser: (next: typeof open) => {
      open = next
    },
    exchange: (next: typeof exchange) => {
      exchange = next
    },
    callback: (index = urls.length - 1) =>
      `koala-clash://auth/callback?state=${new URL(urls[index]).searchParams.get('state')}&code=${grant}`
  }
}

test('reopening an active login preserves the state, verifier, deadline, and original browser callback', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  const original = structuredClone(f.vault()!.pending)
  const saved = f.saves()
  f.clock(startTime + 60_000)

  assert.equal((await f.app.reopenLogin()).status, 'signing-in')
  assert.equal(f.urls[1], f.urls[0])
  assert.deepEqual(f.vault()?.pending, original)
  assert.equal(f.saves(), saved)
  await f.app.acceptCallback(f.callback(0))
  assert.equal((await f.app.getState()).status, 'signed-in')
})

test('reopening an expired attempt creates a fresh login and ignores the old callback', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  const original = structuredClone(f.vault()!.pending!)
  f.clock(original.expiresAt)

  assert.equal((await f.app.reopenLogin()).status, 'signing-in')
  assert.notEqual(f.vault()?.pending?.state, original.state)
  assert.notEqual(f.vault()?.pending?.codeVerifier, original.codeVerifier)
  assert.ok(f.vault()!.pending!.expiresAt > original.expiresAt)
  await f.app.acceptCallback(f.callback(0))
  assert.equal((await f.app.getState()).status, 'signing-in')
  await f.app.acceptCallback(f.callback(1))
  assert.equal((await f.app.getState()).status, 'signed-in')
})

test('reopening without a pending attempt starts a login', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  assert.equal((await f.app.reopenLogin()).status, 'signing-in')
  assert.ok(f.vault()?.pending)
  assert.equal(f.urls.length, 1)
})

test('reopen browser failures preserve a retryable attempt and controlled protocol errors', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  const original = structuredClone(f.vault()?.pending)
  for (const error of [
    new Error('private OS details'),
    new AuthRequestError('protocol-unavailable')
  ]) {
    f.browser(async () => {
      throw error
    })
    assert.deepEqual(await f.app.reopenLogin(), {
      status: 'signing-in',
      persistence: 'none',
      error: error instanceof AuthRequestError ? 'protocol-unavailable' : 'browser-open-failed'
    })
    assert.deepEqual(f.vault()?.pending, original)
  }
  f.browser(async () => {})
  assert.deepEqual(await f.app.reopenLogin(), { status: 'signing-in', persistence: 'none' })
  assert.ok(f.urls.every((url) => url === f.urls[0]))
  assert.ok(!JSON.stringify(f.changes).includes('private OS details'))
})

test('cancelling a reopened login is not overwritten by a late browser failure', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  const opening = deferred<void>()
  const started = deferred<void>()
  f.browser(() => {
    started.resolve()
    return opening.promise
  })
  const reopening = f.app.reopenLogin()
  await started.promise
  await f.app.cancelLogin()
  opening.reject(new Error('late browser failure'))

  assert.deepEqual(await reopening, { status: 'signed-out', persistence: 'none' })
  assert.deepEqual(await f.app.getState(), { status: 'signed-out', persistence: 'none' })
  assert.equal(f.vault()?.pending, undefined)
})

test('reopening during an exchange or after sign-in does not open another browser tab', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  const response = deferred<AuthCredentials>()
  const started = deferred<void>()
  f.exchange(() => {
    started.resolve()
    return response.promise
  })
  const callback = f.app.acceptCallback(f.callback())
  await started.promise

  assert.equal((await f.app.reopenLogin()).status, 'signing-in')
  assert.equal(f.urls.length, 1)
  response.resolve(f.issued())
  await callback
  assert.equal((await f.app.reopenLogin()).status, 'signed-in')
  assert.equal(f.urls.length, 1)
})

test('a late reopen error cannot replace a successful callback in the same generation', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  const opening = deferred<void>()
  const started = deferred<void>()
  f.browser(() => {
    started.resolve()
    return opening.promise
  })
  const reopening = f.app.reopenLogin()
  await started.promise
  await f.app.acceptCallback(f.callback(0))
  opening.reject(new Error('late browser failure'))

  assert.equal((await reopening).status, 'signed-in')
  assert.equal((await f.app.getState()).error, undefined)
})

test('an earlier reopen failure does not override a newer successful reopen', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  const opening = deferred<void>()
  const started = deferred<void>()
  f.browser(() => {
    started.resolve()
    return opening.promise
  })
  const earlier = f.app.reopenLogin()
  await started.promise
  f.browser(async () => {})
  await f.app.reopenLogin()
  opening.reject(new Error('earlier browser failure'))

  assert.deepEqual(await earlier, { status: 'signing-in', persistence: 'none' })
})

test('cancellation can win while an expired reopen is starting a fresh attempt', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  f.clock(f.vault()!.pending!.expiresAt)
  const reopening = f.app.reopenLogin()
  const cancelling = f.app.cancelLogin()
  await Promise.all([reopening, cancelling])

  assert.deepEqual(await f.app.getState(), { status: 'signed-out', persistence: 'none' })
  assert.equal(f.vault()?.pending, undefined)
})
