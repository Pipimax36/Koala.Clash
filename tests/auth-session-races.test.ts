import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAuthSession } from '../src/main/auth/session'
import { AuthRequestError, type AuthCredentials, type AuthVault } from '../src/main/auth/contracts'

const now = 1_800_000_000_000
const issued: AuthCredentials = {
  accessToken: 'private-access',
  expiresAt: now + 300_000,
  user: { id: 'subject' }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture(initial: AuthVault | null = null) {
  let vault = initial
  let delayedSave:
    | {
        matches: (next: AuthVault) => boolean
        started: ReturnType<typeof deferred<void>>
        release: ReturnType<typeof deferred<void>>
      }
    | undefined
  let load = async (): Promise<AuthVault | null> => vault && structuredClone(vault)
  let prepare = async (): Promise<void> => {}
  let exchange = async (): Promise<AuthCredentials> => issued
  let restore = async (): Promise<AuthCredentials> => issued
  let browser = async (): Promise<void> => {}
  const urls: URL[] = []
  const changes: KoalaAuthState[] = []
  const app = createAuthSession({
    now: () => now,
    store: {
      load: () => load(),
      save: async (next) => {
        if (delayedSave?.matches(next)) {
          const waiting = delayedSave
          delayedSave = undefined
          waiting.started.resolve()
          await waiting.release.promise
        }
        vault = structuredClone(next)
        return true
      }
    },
    provider: {
      prepareLogin: () => prepare(),
      authorizationUrl: (pending) =>
        `https://whmcs.coolgo.network/oauth/authorize.php?state=${pending.state}`,
      exchange: () => exchange(),
      restore: () => restore()
    },
    openBrowser: async (url) => {
      urls.push(new URL(url))
      await browser()
    },
    onChange: (value) => changes.push(value)
  })
  return {
    app,
    changes,
    urls,
    vault: () => vault,
    load: (value: typeof load) => {
      load = value
    },
    prepare: (value: typeof prepare) => {
      prepare = value
    },
    exchange: (value: typeof exchange) => {
      exchange = value
    },
    restore: (value: typeof restore) => {
      restore = value
    },
    browser: (value: typeof browser) => {
      browser = value
    },
    callback: (result = 'code=provider-code') =>
      `koala-clash://auth/callback?state=${urls.at(-1)!.searchParams.get('state')}&${result}`,
    delaySave: (matches: (value: AuthVault) => boolean = () => true) => {
      const started = deferred<void>()
      const release = deferred<void>()
      delayedSave = { matches, started, release }
      return { started: started.promise, release: release.resolve }
    }
  }
}
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('logout and cancellation immediately invalidate a startup restore and ignore its late success', async (t) => {
  for (const action of ['logout', 'cancelLogin'] as const) {
    const f = fixture({ version: 2, session: issued })
    t.after(f.app.dispose)
    const started = deferred<void>()
    const result = deferred<AuthCredentials>()
    f.restore(() => {
      started.resolve()
      return result.promise
    })
    const restoring = f.app.getState()
    await started.promise
    assert.equal((await f.app[action]()).status, 'signed-out')
    result.resolve(issued)
    assert.deepEqual(await restoring, { status: 'signed-out', persistence: 'none' })
    assert.equal(f.vault()?.session, undefined)
    assert.ok(f.changes.every((state) => state.status !== 'signed-in'))
  }
})

test('cancelled login commands waiting on startup loading never reopen the browser', async (t) => {
  for (const action of ['login', 'reopenLogin'] as const) {
    const f = fixture()
    t.after(f.app.dispose)
    const started = deferred<void>()
    const loaded = deferred<AuthVault | null>()
    f.load(() => {
      started.resolve()
      return loaded.promise
    })
    const loggingIn = f.app[action]()
    await started.promise
    await f.app.cancelLogin()
    loaded.resolve(null)
    assert.deepEqual(await loggingIn, { status: 'signed-out', persistence: 'none' })
    assert.equal(f.urls.length, 0)
  }
})

test('cancellation while checking configuration prevents opening the browser later', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  const started = deferred<void>()
  const ready = deferred<void>()
  f.prepare(() => {
    started.resolve()
    return ready.promise
  })
  const login = f.app.login()
  await started.promise
  await f.app.cancelLogin()
  ready.resolve()
  assert.deepEqual(await login, { status: 'signed-out', persistence: 'none' })
  assert.equal(f.urls.length, 0)
  assert.equal(f.vault()?.pending, undefined)
})

test('cancelling an in-flight code exchange ignores late credentials without publishing or storing them', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  const started = deferred<void>()
  const result = deferred<AuthCredentials>()
  f.exchange(() => {
    started.resolve()
    return result.promise
  })
  const callback = f.app.acceptCallback(f.callback())
  await started.promise
  await f.app.cancelLogin()
  result.resolve(issued)
  await callback
  assert.deepEqual(await f.app.getState(), { status: 'signed-out', persistence: 'none' })
  assert.equal(f.vault()?.session, undefined)
  assert.ok(f.changes.every((state) => state.status !== 'signed-in'))
})

test('cancelling while persisting exchanged credentials removes the complete session', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  const saved = f.delaySave((value) => Boolean(value.session))
  const callback = f.app.acceptCallback(f.callback())
  await saved.started
  const cancelling = f.app.cancelLogin()
  await nextTurn()
  saved.release()
  await Promise.all([callback, cancelling])
  assert.deepEqual(await f.app.getState(), { status: 'signed-out', persistence: 'none' })
  assert.equal(f.vault()?.session, undefined)
  assert.equal(f.vault()?.pending, undefined)
  assert.ok(f.changes.every((state) => state.status !== 'signed-in'))
  assert.equal((await f.app.login()).status, 'signing-in')
})

test('a denied callback saving its cleanup cannot overwrite a new login', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  const first = f.vault()!.pending!.state
  const saved = f.delaySave()
  const callback = f.app.acceptCallback(f.callback('error=access_denied'))
  await saved.started
  const login = f.app.login()
  await nextTurn()
  saved.release()
  await Promise.all([callback, login])
  assert.deepEqual(await f.app.getState(), { status: 'signing-in', persistence: 'none' })
  assert.notEqual(f.vault()?.pending?.state, first)
})

test('old restore failures cannot replace a newly started login after logout', async (t) => {
  const f = fixture({ version: 2, session: issued })
  t.after(f.app.dispose)
  const started = deferred<void>()
  const result = deferred<AuthCredentials>()
  f.restore(() => {
    started.resolve()
    return result.promise
  })
  const restoring = f.app.getState()
  await started.promise
  await f.app.logout()
  await f.app.login()
  result.reject(new AuthRequestError('identity-invalid'))
  await restoring
  assert.deepEqual(await f.app.getState(), { status: 'signing-in', persistence: 'none' })
  assert.ok(f.vault()?.pending)
})

test('browser failure cleanup cannot overwrite a newer login while saving the vault', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  f.browser(async () => {
    throw new Error('browser failed')
  })
  const saved = f.delaySave((value) => !value.pending && !value.session)
  const failed = f.app.login()
  await saved.started
  f.browser(async () => {})
  const login = f.app.login()
  await nextTurn()
  saved.release()
  await Promise.all([failed, login])
  assert.deepEqual(await f.app.getState(), { status: 'signing-in', persistence: 'none' })
})
