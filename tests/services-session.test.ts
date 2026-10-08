import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAuthSession } from '../src/main/auth/session'
import { createWhmcsServices } from '../src/main/auth/services'
import type { AuthCredentials, AuthPending, AuthVault } from '../src/main/auth/contracts'

function fixture(signedIn = true) {
  let clock = 1_800_000_000_000
  const credentials: AuthCredentials = {
    accessToken: 'private-token',
    idToken: 'private.identity.proof',
    expiresAt: clock + 60_000,
    user: { id: 'same-user' }
  }
  let saved: AuthVault = signedIn ? { version: 2, session: credentials } : { version: 2 }
  let pending: AuthPending | undefined
  const states: KoalaAuthState[] = []
  const session = createAuthSession({
    now: () => clock,
    store: {
      load: async () => saved,
      save: async (value) => {
        saved = value
        return true
      }
    },
    provider: {
      prepareLogin: async () => {},
      authorizationUrl: (value) => {
        pending = value
        return 'https://example.com'
      },
      exchange: async () => ({ ...credentials }),
      restore: async (value) => value
    },
    openBrowser: async () => {},
    onChange: (state) => states.push(state)
  })
  return {
    session,
    states,
    expire: () => {
      clock += 60_001
    },
    relogin: async () => {
      await session.login()
      await session.acceptCallback(
        `koala-clash://auth/callback?code=valid-code&state=${pending!.state}`
      )
    }
  }
}

test('service capability is only available for a currently signed-in session and never appears in UI state', async (t) => {
  const f = fixture(false)
  t.after(() => f.session.dispose())
  await assert.rejects(f.session.serviceSession(), { reason: 'not-signed-in' })
  await f.session.login()
  await assert.rejects(f.session.serviceSession(), { reason: 'not-signed-in' })
  await f.relogin()
  const lease = await f.session.serviceSession()
  assert.equal(lease.identity, 'same-user')
  assert.equal(lease.accessToken, 'private-token')
  assert.equal(lease.idToken, 'private.identity.proof')
  lease.assertCurrent()
  assert(!JSON.stringify(f.states).includes('private-token'))
  assert(!JSON.stringify(f.states).includes('private.identity.proof'))
})

test('logout then login as the same identity invalidates old service capabilities by generation', async (t) => {
  const f = fixture()
  t.after(() => f.session.dispose())
  const old = await f.session.serviceSession()
  await f.session.logout()
  assert.throws(old.assertCurrent, { reason: 'session-changed' })
  await f.relogin()
  const current = await f.session.serviceSession()
  current.assertCurrent()
  assert.equal(old.identity, current.identity)
  assert.throws(old.assertCurrent, { reason: 'session-changed' })
})

test('expiry invalidates a capability even before the timer processes the state change', async (t) => {
  const f = fixture()
  t.after(() => f.session.dispose())
  const lease = await f.session.serviceSession()
  f.expire()
  assert.throws(lease.assertCurrent, { reason: 'session-changed' })
  await assert.rejects(f.session.serviceSession(), { reason: 'not-signed-in' })
})

test('a response from before logout/relogin cannot enter the new service list even for the same account', async (t) => {
  const f = fixture()
  t.after(() => f.session.dispose())
  let release!: (value: Response) => void
  let requested!: () => void
  const started = new Promise<void>((resolve) => {
    requested = resolve
  })
  const api = createWhmcsServices({
    getSession: f.session.serviceSession,
    getProfiles: async () => [],
    importProfile: async () => {
      throw Error('not expected')
    },
    fetch: async () => {
      requested()
      return new Promise((resolve) => {
        release = resolve
      })
    }
  })
  const result = api.list()
  await started
  await f.session.logout()
  await f.relogin()
  release(
    new Response(JSON.stringify({ version: 1, services: [{ id: 1, name: 'Old response' }] }), {
      headers: { 'Content-Type': 'application/json' }
    })
  )
  assert.deepEqual(await result, { ok: false, error: 'session-changed' })
})

test('best-effort binding runs again after logout and same-account login rather than reusing an old generation', async (t) => {
  const f = fixture()
  t.after(() => f.session.dispose())
  let requests = 0
  const api = createWhmcsServices({
    getSession: f.session.serviceSession,
    getProfiles: async () => [],
    importProfile: async () => {
      throw Error('unexpected')
    },
    fetch: async () => {
      requests++
      return new Response(JSON.stringify({ version: 1, bound: true }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }
  })
  assert.equal(await api.bind(), true)
  assert.equal(await api.bind(), true)
  assert.equal(requests, 1)
  await f.session.logout()
  await f.relogin()
  assert.equal(await api.bind(), true)
  assert.equal(requests, 2)
})
