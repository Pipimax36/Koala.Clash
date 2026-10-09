import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAuthSession } from '../src/main/auth/session'
import {
  AuthRequestError,
  type AuthCredentials,
  type AuthPending,
  type AuthVault
} from '../src/main/auth/contracts'

const startTime = 1_800_000_000_000
const issued = (now = startTime): AuthCredentials => ({
  accessToken: 'private-provider-access-token',
  expiresAt: now + 300_000,
  user: { id: 'verified-subject', name: 'Verified customer', email: 'customer@example.com' }
})

function fixture(initial: AuthVault | null = null) {
  let clock = startTime
  let vault = initial
  let encrypted = true
  let prepareError: Error | undefined
  let loadError = false
  let loads = 0
  let saves = 0
  let restore = async (_value: AuthCredentials): Promise<AuthCredentials> => issued(clock)
  const urls: URL[] = []
  const changes: KoalaAuthState[] = []
  const exchanges: { code: string; pending: AuthPending }[] = []
  const restores: AuthCredentials[] = []
  let prepares = 0
  const app = createAuthSession({
    now: () => clock,
    store: {
      load: async () => {
        loads++
        if (loadError) throw Error('private storage details')
        return vault && structuredClone(vault)
      },
      save: async (next) => {
        saves++
        vault = encrypted ? structuredClone(next) : null
        return encrypted
      }
    },
    provider: {
      prepareLogin: async () => {
        prepares++
        if (prepareError) throw prepareError
      },
      authorizationUrl: (pending) =>
        `https://whmcs.coolgo.network/oauth/authorize.php?state=${pending.state}&nonce=${pending.nonce}`,
      exchange: async (code, pending) => {
        exchanges.push({ code, pending })
        return issued(clock)
      },
      restore: async (value) => {
        restores.push(value)
        return restore(value)
      }
    },
    openBrowser: async (url) => {
      urls.push(new URL(url))
    },
    onChange: (state) => changes.push(state)
  })
  return {
    app,
    urls,
    changes,
    exchanges,
    restores,
    vault: () => vault,
    prepares: () => prepares,
    loads: () => loads,
    saves: () => saves,
    clock: (value: number) => {
      clock = value
    },
    encrypted: (value: boolean) => {
      encrypted = value
    },
    prepareError: (value: Error) => {
      prepareError = value
    },
    loadError: (value = true) => {
      loadError = value
    },
    restore: (value: typeof restore) => {
      restore = value
    },
    callback: (code = 'WHMCS.code+/=:opaque!') => {
      const url = new URL('koala-clash://auth/callback')
      url.searchParams.set('state', urls.at(-1)!.searchParams.get('state')!)
      url.searchParams.set('code', code)
      return url.toString()
    }
  }
}

test('login prepares the provider, persists independent nonce/verifier/state, and only publishes identity', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  assert.equal((await f.app.login()).status, 'signing-in')
  assert.equal(f.prepares(), 1)
  const pending = structuredClone(f.vault()!.pending!)
  assert.equal(new Set([pending.state, pending.nonce, pending.codeVerifier]).size, 3)
  assert.ok(
    [pending.state, pending.nonce, pending.codeVerifier].every((value) =>
      /^[A-Za-z0-9_-]{43}$/.test(value)
    )
  )
  assert.equal(f.urls[0].searchParams.get('nonce'), pending.nonce)
  await f.app.acceptCallback(f.callback())
  assert.deepEqual(f.exchanges, [{ code: 'WHMCS.code+/=:opaque!', pending }])
  const state = await f.app.getState()
  assert.equal(state.status, 'signed-in')
  assert.equal(state.persistence, 'encrypted')
  assert.deepEqual(state.user, issued().user)
  for (const secret of [issued().accessToken, pending.codeVerifier, pending.nonce]) {
    assert.ok(!JSON.stringify(f.changes).includes(secret))
  }
  assert.equal(f.vault()!.pending, undefined)
  assert.equal(f.vault()!.session!.accessToken, issued().accessToken)
  await f.app.acceptCallback(f.callback())
  assert.equal(f.exchanges.length, 1, 'duplicate callbacks do not redeem the code twice')
})

test('callback rejects forged state, duplicate or unknown fields, wrong paths, and invalid authorization codes', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  assert.equal(await f.app.acceptCallback(f.callback().replace('koala-clash:', 'https:')), false)
  await f.app.acceptCallback(f.callback().replace(/state=[^&]+/, 'state=forged'))
  assert.equal((await f.app.getState()).status, 'signing-in')
  assert.equal(f.exchanges.length, 0)
  for (const change of [
    (url: string) => `${url}&code=duplicate`,
    (url: string) => `${url}&token=unexpected`,
    (url: string) => url.replace('/callback?', '/other?'),
    (url: string) => `${url}&error=access_denied`,
    (url: string) => `${url}#fragment`
  ]) {
    await f.app.login()
    await f.app.acceptCallback(change(f.callback()))
    assert.equal((await f.app.getState()).error, 'invalid-callback')
  }
  for (const code of ['', 'contains space', 'line\nbreak', '非ASCII', 'x'.repeat(4097)]) {
    await f.app.login()
    await f.app.acceptCallback(f.callback(code))
    assert.equal((await f.app.getState()).error, 'invalid-callback')
  }
  assert.equal(f.exchanges.length, 0)
})

test('OAuth denial accepts bounded descriptive fields without exposing provider text', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  await f.app.login()
  const callback = new URL(f.callback())
  callback.searchParams.delete('code')
  callback.searchParams.set('error', 'access_denied')
  callback.searchParams.set('error_description', 'Sensitive provider detail')
  callback.searchParams.set('error_uri', 'https://provider.example/error')
  await f.app.acceptCallback(callback.toString())
  assert.equal((await f.app.getState()).error, 'access-denied')
  assert.ok(!JSON.stringify(f.changes).includes('Sensitive provider detail'))
  await f.app.login()
  const oversized = new URL(f.callback())
  oversized.searchParams.set('error_description', 'x'.repeat(2049))
  await f.app.acceptCallback(oversized.toString())
  assert.equal((await f.app.getState()).error, 'invalid-callback')
  assert.equal(f.exchanges.length, 0)
})

test('pending nonce and verifier survive restart for the same provider callback', async (t) => {
  const original = fixture()
  t.after(original.app.dispose)
  await original.app.login()
  const restarted = fixture(original.vault())
  t.after(restarted.app.dispose)
  await restarted.app.acceptCallback(original.callback())
  assert.equal((await restarted.app.getState()).status, 'signed-in')
  assert.deepEqual(restarted.exchanges[0].pending, original.vault()!.pending)
})

test('a declined callback restore keeps the pending attempt intact for retry', async (t) => {
  const original = fixture()
  t.after(original.app.dispose)
  await original.app.login()
  const pendingVault = structuredClone(original.vault())
  const restarted = fixture(pendingVault)
  t.after(restarted.app.dispose)
  restarted.loadError()
  await restarted.app.acceptCallback(original.callback())
  assert.equal((await restarted.app.getState()).error, 'storage-error')
  assert.deepEqual(restarted.vault(), pendingVault)
  assert.equal(restarted.saves(), 0)
  assert.equal(restarted.exchanges.length, 0)
  restarted.loadError(false)
  await restarted.app.acceptCallback(original.callback())
  assert.equal((await restarted.app.getState()).status, 'signed-in')
  assert.equal(restarted.exchanges.length, 1)
})

test('startup and focus reads stay in memory until account restoration is requested', async (t) => {
  const f = fixture({ version: 2, session: issued() })
  t.after(f.app.dispose)
  assert.ok(
    (await Promise.all([f.app.getState(), f.app.getState()])).every(
      (state) => state.status === 'signed-out'
    )
  )
  assert.equal(f.loads(), 0)
  assert.equal(f.restores.length, 0)
  assert.equal(f.saves(), 0)
  assert.equal((await f.app.restoreSession()).status, 'signed-in')
  await f.app.getState()
  await f.app.restoreSession()
  assert.equal(f.loads(), 1)
  assert.equal(f.restores.length, 1)
  assert.equal(f.saves(), 0, 'restoring an encrypted vault does not require another encryption')
})

test('refusing account storage preserves credentials and retries only after an explicit action', async (t) => {
  const initial: AuthVault = { version: 2, session: issued() }
  const f = fixture(initial)
  t.after(f.app.dispose)
  f.loadError()
  assert.equal((await f.app.restoreSession()).error, 'storage-error')
  assert.deepEqual(f.vault(), initial)
  assert.equal(f.saves(), 0)
  await f.app.getState()
  await f.app.getState()
  assert.equal(f.loads(), 1, 'focus does not retry a rejected keychain request')
  assert.equal((await f.app.login()).error, 'storage-error')
  assert.equal(f.urls.length, 0)
  assert.deepEqual(f.vault(), initial, 'failed recovery must not replace an existing account')
  f.loadError(false)
  assert.equal((await f.app.restoreSession()).status, 'signed-in')
})

test('service requests explicitly restore a cached account without requiring a startup restore', async (t) => {
  const f = fixture({ version: 2, session: issued() })
  t.after(f.app.dispose)
  assert.equal((await f.app.serviceSession()).identity, issued().user.id)
  assert.equal(f.loads(), 1)
  assert.equal(f.restores.length, 1)
})

test('concurrent explicit restores validate the remembered identity once before publishing signed-in', async (t) => {
  const f = fixture({
    version: 2,
    session: { ...issued(), user: { id: 'verified-subject', name: 'Cached name' } }
  })
  t.after(f.app.dispose)
  let resolve!: (value: AuthCredentials) => void
  let started!: () => void
  const began = new Promise<void>((done) => {
    started = done
  })
  f.restore(
    () =>
      new Promise((done) => {
        resolve = done
        started()
      })
  )
  const states = Promise.all([
    f.app.restoreSession(),
    f.app.restoreSession(),
    f.app.restoreSession()
  ])
  await began
  assert.equal(
    (await f.app.getState()).status,
    'signed-out',
    'memory reads do not wait for restoration'
  )
  assert.equal(f.restores.length, 1)
  assert.ok(f.changes.every((state) => state.status !== 'signed-in'))
  resolve(issued())
  assert.ok((await states).every((state) => state.user?.name === 'Verified customer'))
})

test('expired credentials are cleared without restore or token refresh; running sessions also expire', async (t) => {
  const expired = fixture({ version: 2, session: { ...issued(), expiresAt: startTime } })
  t.after(expired.app.dispose)
  assert.equal((await expired.app.restoreSession()).error, 'session-expired')
  assert.equal(expired.restores.length, 0)
  assert.equal(expired.vault()?.session, undefined)
  const active = fixture()
  t.after(active.app.dispose)
  await active.app.login()
  await active.app.acceptCallback(active.callback())
  active.clock(issued().expiresAt)
  assert.deepEqual(await active.app.getState(), {
    status: 'signed-out',
    persistence: 'none',
    error: 'session-expired'
  })
  assert.equal(active.vault()?.session, undefined)
  assert.equal(active.restores.length, 0)
})

test('a failed restore discards cached identity and credentials instead of claiming login', async (t) => {
  const f = fixture({ version: 2, session: issued() })
  t.after(f.app.dispose)
  f.restore(async () => {
    throw new AuthRequestError('network-error')
  })
  assert.deepEqual(await f.app.restoreSession(), {
    status: 'signed-out',
    persistence: 'none',
    error: 'network-error'
  })
  assert.equal(f.vault()?.session, undefined)
  await f.app.getState()
  assert.equal(f.restores.length, 1)
})

test('long-lived provider sessions schedule expiry across the Node timer limit', async (t) => {
  const lifetime = 30 * 86_400_000
  const maxDelay = 2_147_483_647
  const credentials = { ...issued(), expiresAt: startTime + lifetime }
  const f = fixture({ version: 2, session: credentials })
  t.after(f.app.dispose)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.restore(async (value) => value)
  assert.equal((await f.app.restoreSession()).status, 'signed-in')

  f.clock(startTime + maxDelay)
  t.mock.timers.tick(maxDelay)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(f.changes.at(-1)?.status, 'signed-in')
  f.clock(startTime + lifetime)
  t.mock.timers.tick(lifetime - maxDelay)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(f.changes.at(-1)?.error, 'session-expired')
  assert.equal(f.vault()?.session, undefined)
})

test('missing provider configuration stops before browser opening and exposes only a controlled error', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  f.prepareError(new AuthRequestError('configuration-error'))
  assert.equal((await f.app.login()).error, 'configuration-error')
  assert.equal(f.urls.length, 0)
  assert.equal(f.vault()?.pending, undefined)
  const unreadable = fixture()
  t.after(unreadable.app.dispose)
  unreadable.loadError()
  assert.equal((await unreadable.app.restoreSession()).error, 'storage-error')
  assert.ok(!JSON.stringify(unreadable.changes).includes('private storage details'))
})

test('unavailable encryption uses only memory and logout clears locally without provider requests', async (t) => {
  const f = fixture()
  t.after(f.app.dispose)
  f.encrypted(false)
  await f.app.login()
  await f.app.acceptCallback(f.callback())
  assert.equal((await f.app.getState()).persistence, 'memory')
  assert.equal(f.vault(), null)
  assert.deepEqual(await f.app.logout(), { status: 'signed-out', persistence: 'none' })
  assert.equal(f.exchanges.length, 1)
  assert.equal(f.restores.length, 0)
})
