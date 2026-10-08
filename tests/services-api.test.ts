import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createWhmcsServices,
  ServiceRequestError,
  serviceProfileId,
  type ServiceImport
} from '../src/main/auth/services'
import { AUTH_ORIGIN } from '../src/main/auth/contracts'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
const item = { id: 72, name: 'Monthly service', nextDueDate: '2026-11-12' }
function fixture(onDiagnostic?: (event: unknown) => void) {
  let current = true
  let profiles: ProfileItem[] = []
  let selectedProfile: string | undefined
  let respond = async (): Promise<Response> => json({ version: 1, services: [item] })
  const calls: { url: string; options: RequestInit; data: Record<string, unknown> }[] = []
  const imports: ServiceImport[] = []
  const diagnostics: unknown[] = []
  const api = createWhmcsServices({
    onDiagnostic: (event) => {
      diagnostics.push(event)
      onDiagnostic?.(event)
    },
    getSession: async () => ({
      identity: 'user-a',
      accessToken: 'private-token',
      idToken: 'private.identity.proof',
      assertCurrent() {
        if (!current) throw new ServiceRequestError('session-changed')
      }
    }),
    getProfiles: async () => profiles,
    getCurrentProfileId: async () => selectedProfile,
    importProfile: async (input) => {
      input.assertCurrent()
      imports.push(input)
      const alreadyImported = profiles.some((profile) => profile.id === input.profileId)
      profiles = [
        {
          id: input.profileId,
          type: 'remote',
          name: input.name,
          whmcsServices: [{ identity: input.identity, serviceId: input.id }]
        }
      ]
      return { profileId: input.profileId, alreadyImported }
    },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options: options!, data: JSON.parse(options!.body as string) })
      return respond()
    }
  })
  return {
    api,
    calls,
    imports,
    diagnostics,
    select: (id: string | undefined) => {
      selectedProfile = id
    },
    profiles: (value: ProfileItem[]) => {
      profiles = value
    },
    respond: (value: typeof respond) => {
      respond = value
    },
    invalidate: () => {
      current = false
    }
  }
}

test('list uses the fixed authenticated POST and returns only display fields with account-scoped imported state', async () => {
  const f = fixture()
  f.profiles([
    {
      id: 'manual',
      name: 'manual',
      type: 'remote',
      whmcsServices: [{ identity: 'another-user', serviceId: 72 }]
    }
  ])
  f.select('manual')
  assert.deepEqual(await f.api.list(), {
    ok: true,
    services: [{ ...item, imported: false, active: false }]
  })
  const request = f.calls[0]
  assert.equal(request.url, `${AUTH_ORIGIN}/modules/addons/koala_services/api.php`)
  assert.deepEqual(request.data, { action: 'list', identityToken: 'private.identity.proof' })
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.redirect, 'error')
  assert.equal(request.options.credentials, 'omit')
  assert.equal(new Headers(request.options.headers).get('authorization'), 'Bearer private-token')
  assert.equal(new Headers(request.options.headers).get('x-koala-identity-token'), null)
  assert.equal(new Headers(request.options.headers).get('content-type'), 'application/json')
  f.profiles([
    {
      id: 'manual',
      name: 'manual',
      type: 'remote',
      whmcsServices: [{ identity: 'user-a', serviceId: 72 }]
    }
  ])
  assert.deepEqual(await f.api.list(), {
    ok: true,
    services: [{ ...item, imported: true, active: true }]
  })
  f.select(undefined)
  assert.deepEqual(await f.api.list(), {
    ok: true,
    services: [{ ...item, imported: true, active: false }]
  })
})

test('every import resolves server ownership again and repeated imports target one stable profile', async () => {
  const f = fixture()
  f.respond(async () =>
    json({
      version: 1,
      service: item,
      subscriptionUrl: 'https://subscription.example/clash?key=private-url'
    })
  )
  const first = await f.api.importService(72)
  assert.deepEqual(first, {
    ok: true,
    profileId: serviceProfileId('user-a', 72),
    alreadyImported: false
  })
  assert.deepEqual(await f.api.importService(72), { ...first, alreadyImported: true })
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[0].data, {
    action: 'resolve',
    serviceId: 72,
    identityToken: 'private.identity.proof'
  })
  assert.equal(f.imports[0].subscriptionUrl, 'https://subscription.example/clash?key=private-url')
  assert(!JSON.stringify(first).includes('private'))
  const completed = f.diagnostics.at(-1) as Record<string, unknown>
  assert.equal(completed.action, 'resolve')
  assert.equal(completed.event, 'complete')
  assert.equal(completed.alreadyImported, true)
  assert(!JSON.stringify(f.diagnostics).includes('private'))
  assert.notEqual(serviceProfileId('user-a', 72), serviceProfileId('user-b', 72))
})

test('list validates version, shape, IDs, duplicates, names and actual calendar dates', async () => {
  const f = fixture()
  for (const body of [
    {},
    { version: 2, services: [] },
    { version: 1, services: {} },
    { version: 1, services: [item, item] },
    { version: 1, services: Array(1001).fill(item) },
    ...[
      { id: '72' },
      { id: -1 },
      { id: 1.5 },
      { id: Number.MAX_SAFE_INTEGER + 1 },
      { name: '' },
      { name: 'a'.repeat(257) },
      { name: 'bad\nname' },
      { nextDueDate: '2026-02-30' },
      { nextDueDate: 'tomorrow' }
    ].map((change) => ({ version: 1, services: [{ ...item, ...change }] }))
  ]) {
    f.respond(async () => json(body))
    assert.deepEqual(await f.api.list(), { ok: false, error: 'invalid-response' })
  }
})

test('resolve rejects foreign service IDs and unsafe/malformed subscription destinations before importing', async () => {
  const f = fixture()
  for (const url of [
    'http://example.com/a',
    'file:///secret',
    'https://u:p@example.com',
    'https://example.com\\private',
    'https://example.com/#secret',
    'https://example.com/bad path',
    4
  ]) {
    f.respond(async () => json({ version: 1, service: item, subscriptionUrl: url }))
    assert.deepEqual(await f.api.importService(72), { ok: false, error: 'invalid-response' })
  }
  f.respond(async () =>
    json({ version: 1, service: { ...item, id: 73 }, subscriptionUrl: 'https://example.com/a' })
  )
  assert.deepEqual(await f.api.importService(72), { ok: false, error: 'invalid-response' })
  assert.equal(f.imports.length, 0)
  const before = f.calls.length
  for (const value of [0, -1, 1.1, NaN, Infinity, '72', { id: 72 }]) {
    assert.deepEqual(await f.api.importService(value as number), {
      ok: false,
      error: 'service-unavailable'
    })
  }
  assert.equal(f.calls.length, before)
})

test('status failures and provider diagnostics produce fixed redacted errors', async () => {
  const f = fixture()
  const cases: [number, unknown, KoalaServiceError][] = [
    [401, { error: 'private-token' }, 'not-signed-in'],
    [403, { error: 'private-token' }, 'access-denied'],
    [404, { error: 'anything' }, 'service-unavailable'],
    [503, { error: 'configuration-error', detail: 'private-token' }, 'configuration-error'],
    [503, { error: 'network-error' }, 'network-error'],
    [503, { error: 'upstream stack private-token' }, 'network-error'],
    [400, { error: 'private-token' }, 'invalid-response']
  ]
  for (const [status, body, error] of cases) {
    f.respond(async () => json(body, status))
    assert.deepEqual(await f.api.list(), { ok: false, error })
  }
  f.respond(
    async () =>
      new Response('<html>private-token</html>', {
        status: 404,
        headers: { 'Content-Type': 'text/html' }
      })
  )
  assert.deepEqual(await f.api.list(), { ok: false, error: 'plugin-unavailable' })
  f.respond(async () => {
    throw new Error('private-token')
  })
  assert.deepEqual(await f.api.list(), { ok: false, error: 'network-error' })
})

test('bounded streaming JSON rejects oversized and malformed response bodies', async () => {
  const f = fixture()
  for (const response of [
    new Response('{bad private-token', { headers: { 'Content-Type': 'application/json' } }),
    new Response('a'.repeat(256 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '9999999' }
    })
  ]) {
    f.respond(async () => response)
    assert.deepEqual(await f.api.list(), { ok: false, error: 'invalid-response' })
  }
})

test('logout while an API response is pending invalidates the response and prevents import', async () => {
  const f = fixture()
  f.respond(async () => {
    f.invalidate()
    return json({ version: 1, service: item, subscriptionUrl: 'https://example.com/a' })
  })
  assert.deepEqual(await f.api.importService(72), { ok: false, error: 'session-changed' })
  assert.equal(f.imports.length, 0)
})

test('request deadline aborts the actual fetch signal with a controlled network failure', async () => {
  const diagnostics: unknown[] = []
  const api = createWhmcsServices({
    onDiagnostic: (event) => diagnostics.push(event),
    getSession: async () => ({
      identity: 'a',
      accessToken: 'private-token',
      idToken: 'private.identity.proof',
      assertCurrent() {
        // This fixture deliberately retains its identity throughout the request.
      }
    }),
    getProfiles: async () => [],
    importProfile: async () => {
      throw Error('unreachable')
    },
    timeoutMs: 5,
    fetch: async (_url, options) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(Error('did not abort')), 1000)
        options!.signal!.addEventListener('abort', () => {
          clearTimeout(keepAlive)
          reject(Error('private-token'))
        })
      })
  })
  assert.deepEqual(await api.list(), { ok: false, error: 'network-error' })
  const last = diagnostics.at(-1) as Record<string, unknown>
  assert.equal(last.timedOut, true)
  assert.equal(last.error, 'network-error')
  assert(!JSON.stringify(diagnostics).includes('private-token'))
})

test('bind sends the client identity proof once per session and remains best effort when the addon is unavailable', async () => {
  const f = fixture()
  f.respond(async () => json({ version: 1, bound: true }))
  assert.equal(await f.api.bind(), true)
  assert.equal(await f.api.bind(), true)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].data, { action: 'bind', identityToken: 'private.identity.proof' })
  assert.equal(new Headers(f.calls[0].options.headers).get('x-koala-identity-token'), null)
  const missing = fixture()
  missing.respond(async () => new Response('unavailable', { status: 404 }))
  assert.equal(await missing.api.bind(), false)
  assert.deepEqual(await missing.api.list(), { ok: false, error: 'plugin-unavailable' })
})

test('legacy sessions without an ID token require login again before any service network request', async () => {
  let requests = 0
  for (const idToken of [
    undefined,
    '',
    'not-a-jwt',
    'a.b.c\r\nHeader: injected',
    `${'x'.repeat(16_384)}.b.c`
  ]) {
    const api = createWhmcsServices({
      getSession: async () => ({
        identity: 'legacy-user',
        accessToken: 'private-token',
        idToken,
        assertCurrent() {
          // The account itself is still signed in; its proof is missing or invalid.
        }
      }),
      getProfiles: async () => [],
      importProfile: async () => {
        throw Error('unexpected')
      },
      fetch: async () => {
        requests++
        return json({ version: 1, services: [] })
      }
    })
    assert.equal(await api.bind(), false)
    assert.deepEqual(await api.list(), { ok: false, error: 'not-signed-in' })
    assert.deepEqual(await api.importService(72), { ok: false, error: 'not-signed-in' })
  }
  assert.equal(requests, 0)
})

test('a failed background bind can retry after transient network recovery', async () => {
  const f = fixture()
  f.respond(async () => {
    throw Error('temporary outage')
  })
  assert.equal(await f.api.bind(), false)
  f.respond(async () => json({ version: 1, bound: true }))
  assert.equal(await f.api.bind(), true)
  assert.equal(await f.api.bind(), true)
  assert.equal(f.calls.length, 2)
})

test('empty lists log response correlation and filter counts without credentials or account details', async () => {
  const f = fixture()
  f.respond(
    async () =>
      new Response(
        JSON.stringify({
          version: 1,
          services: [],
          email: 'private-person@example.com',
          diagnostics: {
            version: 1,
            reason: 'product-not-enabled',
            clientCount: 1,
            ownedServices: 2,
            activeServices: 1,
            allowedServices: 0,
            allowedProductIds: [1, 2, 3],
            token: 'private-token',
            subject: 'private-subject'
          }
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Koala-Services-Version': '1.0.3',
            'X-Koala-Request-Id': 'aa54d11585c856f5'
          }
        }
      )
  )
  assert.deepEqual(await f.api.list(), { ok: true, services: [] })
  const events = f.diagnostics as Array<Record<string, unknown>>
  assert.deepEqual(
    events.map(({ event }) => event),
    ['start', 'response', 'complete']
  )
  assert.equal(new Set(events.map(({ operationId }) => operationId)).size, 1)
  assert.match(String(events[0].operationId), /^[a-f0-9]{16}$/)
  const completed = events.at(-1)!
  assert.equal(completed.action, 'list')
  assert.equal(completed.httpStatus, 200)
  assert.equal(completed.serviceCount, 0)
  assert.equal(completed.pluginVersion, '1.0.3')
  assert.equal(completed.requestId, 'aa54d11585c856f5')
  assert.equal((completed.query as Record<string, unknown>).reason, 'product-not-enabled')
  const serialized = JSON.stringify(events)
  for (const secret of [
    'private-token',
    'private.identity.proof',
    'private-person',
    'private-subject',
    'user-a'
  ]) {
    assert(!serialized.includes(secret))
  }
})

test('authentication rejection records only allowlisted addon diagnostics even on HTTP 403', async () => {
  const f = fixture()
  f.respond(async () =>
    json(
      {
        error: 'access-denied',
        diagnostic: 'client-closed',
        requestId: 'aa54d11585c856f5',
        detail: 'private-token',
        url: 'https://example.com/private-subscription'
      },
      403
    )
  )
  assert.deepEqual(await f.api.list(), { ok: false, error: 'access-denied' })
  const last = f.diagnostics.at(-1) as Record<string, unknown>
  assert.equal(last.event, 'failed')
  assert.equal(last.error, 'access-denied')
  assert.equal(last.diagnostic, 'client-closed')
  assert.equal(last.requestId, 'aa54d11585c856f5')
  assert(!JSON.stringify(f.diagnostics).includes('private'))
})

test('legacy addon empty responses are logged without inventing a filter reason', async () => {
  const f = fixture()
  f.respond(async () => json({ version: 1, services: [] }))
  assert.deepEqual(await f.api.list(), { ok: true, services: [] })
  const last = f.diagnostics.at(-1) as Record<string, unknown>
  assert.equal(last.serviceCount, 0)
  assert.equal(last.query, undefined)
  assert.equal(last.pluginVersion, undefined)
})

test('resolve failures retain safe provider reason and never log the response body', async () => {
  const f = fixture()
  f.respond(async () =>
    json(
      {
        error: 'service-unavailable',
        diagnostic: 'remnawave-user-expired',
        requestId: 'aa54d11585c856f5',
        subscriptionUrl: 'https://example.com/private-link',
        token: 'private-token',
        email: 'private-person@example.com'
      },
      409
    )
  )
  assert.deepEqual(await f.api.importService(72), { ok: false, error: 'service-unavailable' })
  const last = f.diagnostics.at(-1) as Record<string, unknown>
  assert.equal(last.action, 'resolve')
  assert.equal(last.event, 'failed')
  assert.equal(last.httpStatus, 409)
  assert.equal(last.diagnostic, 'remnawave-user-expired')
  assert(!JSON.stringify(f.diagnostics).includes('private'))
})

test('a diagnostic writer failure cannot turn a successful list or import into an error', async () => {
  const f = fixture(() => {
    throw new Error('diagnostic disk unavailable')
  })
  assert.deepEqual(await f.api.list(), {
    ok: true,
    services: [{ ...item, imported: false, active: false }]
  })
  f.respond(async () =>
    json({ version: 1, service: item, subscriptionUrl: 'https://example.com/private-link' })
  )
  assert.equal((await f.api.importService(72)).ok, true)
})
