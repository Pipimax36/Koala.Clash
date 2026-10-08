import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createServiceDiagnostics,
  sanitizeServiceDiagnostic,
  type ServiceDiagnostic
} from '../src/main/auth/services-diagnostics'

test('mapping diagnostics keep fixed codes without logging the service or panel identity', () => {
  for (const diagnostic of ['whmcs-remnawave-mapping-missing', 'whmcs-remnawave-mapping-invalid']) {
    const base = { action: 'resolve', event: 'failed', operationId: '0123456789abcdef' }
    assert.deepEqual(
      sanitizeServiceDiagnostic({
        ...base,
        diagnostic,
        serviceId: 2330,
        domain: '3079',
        remnawaveUserId: 3079
      }),
      { ...base, diagnostic }
    )
  }
})

test('activation failure is recorded as a fixed error without raw core exceptions', () => {
  const event = {
    action: 'resolve',
    event: 'failed',
    operationId: '0123456789abcdef',
    stage: 'import',
    error: 'activation-failed'
  }
  assert.deepEqual(sanitizeServiceDiagnostic({ ...event, cause: 'private core message' }), event)
})

test('diagnostic sanitization keeps only fixed operational fields and drops private payloads', () => {
  const sanitized = sanitizeServiceDiagnostic({
    action: 'resolve',
    event: 'failed',
    operationId: '0123456789abcdef',
    stage: 'request',
    durationMs: 42,
    httpStatus: 404,
    contentType: 'json',
    pluginVersion: '1.0.3',
    requestId: 'fedcba9876543210',
    error: 'service-unavailable',
    diagnostic: 'remnawave-user-not-found',
    accessToken: 'never-log-this-token',
    identityToken: 'never-log-this-jwt',
    subscriptionUrl: 'https://secret.example/private',
    email: 'private@example.com',
    response: { username: 'private-user' },
    request: { password: 'secret' },
    query: {
      version: 1,
      reason: 'product-not-enabled',
      clientCount: 1,
      ownedServices: 5,
      activeServices: 3,
      allowedServices: 0,
      allowedProductIds: [4, 8],
      email: 'private@example.com',
      accountId: 123,
      raw: 'private body'
    }
  })
  assert.deepEqual(sanitized, {
    action: 'resolve',
    event: 'failed',
    operationId: '0123456789abcdef',
    stage: 'request',
    durationMs: 42,
    httpStatus: 404,
    contentType: 'json',
    pluginVersion: '1.0.3',
    requestId: 'fedcba9876543210',
    error: 'service-unavailable',
    diagnostic: 'remnawave-user-not-found',
    query: {
      version: 1,
      reason: 'product-not-enabled',
      clientCount: 1,
      ownedServices: 5,
      activeServices: 3,
      allowedServices: 0,
      allowedProductIds: [4, 8]
    }
  })
  assert(!JSON.stringify(sanitized).includes('private'))
  assert(!JSON.stringify(sanitized).includes('never-log'))
})

test('rotation keeps only the current log and one bounded private backup with complete lines', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'koala-diagnostics-rotate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filePath = join(root, 'whmcs-services.log')
  await writeFile(filePath, '', { mode: 0o644 })
  const logger = createServiceDiagnostics({
    filePath: () => filePath,
    appVersion: () => '1.4.3',
    maxBytes: 1024
  })
  for (let index = 0; index < 40; index++)
    logger.write({
      action: 'list',
      event: 'complete',
      operationId: '0123456789abcdef',
      serviceCount: index
    })
  await logger.flush()
  assert.deepEqual((await readdir(root)).sort(), ['whmcs-services.log', 'whmcs-services.log.1'])
  for (const file of [filePath, `${filePath}.1`]) {
    const info = await stat(file)
    assert(info.size <= 1024)
    if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600)
    const raw = await readFile(file, 'utf8')
    assert(raw.endsWith('\n'))
    for (const line of raw.trimEnd().split('\n')) {
      assert(Buffer.byteLength(line + '\n') <= 4096)
      assert.equal(JSON.parse(line).component, 'whmcs-services')
    }
  }
  const latest = (await readFile(filePath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(latest.at(-1).serviceCount, 39)
})

test('diagnostics persist private JSONL records without credentials, mutable payloads or arbitrary app metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'koala-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filePath = join(root, 'logs', 'whmcs-services.log')
  const logger = createServiceDiagnostics({ filePath: () => filePath, appVersion: () => '1.4.3' })
  const payload = {
    action: 'list',
    event: 'complete',
    operationId: '0123456789abcdef',
    serviceCount: 3,
    importedCount: 1,
    token: 'private-token',
    response: { email: 'private@example.com' }
  }
  logger.write(payload as ServiceDiagnostic)
  payload.serviceCount = 999
  await logger.flush()
  const raw = await readFile(filePath, 'utf8')
  assert(raw.endsWith('\n'))
  assert(!raw.includes('private'))
  const output = JSON.parse(raw)
  assert.deepEqual(output, {
    time: output.time,
    component: 'whmcs-services',
    appVersion: '1.4.3',
    action: 'list',
    event: 'complete',
    operationId: '0123456789abcdef',
    serviceCount: 3,
    importedCount: 1
  })
  assert.equal(new Date(output.time).toISOString(), output.time)
  if (process.platform !== 'win32') assert.equal((await stat(filePath)).mode & 0o777, 0o600)
})

test('burst logging bounds its pending queue and preserves complete ordered records while recovering capacity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'koala-diagnostics-queue-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filePath = join(root, 'whmcs-services.log')
  const logger = createServiceDiagnostics({ filePath: () => filePath, appVersion: () => '1.4.3' })
  for (let index = 0; index < 2000; index++)
    logger.write({
      action: 'list',
      event: 'complete',
      operationId: '0123456789abcdef',
      serviceCount: index
    })
  await logger.flush()
  let records = (await readFile(filePath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(records.length, 1000)
  assert.equal(records[0].serviceCount, 0)
  assert.equal(records.at(-1).serviceCount, 999)
  assert.equal(new Set(records.map((record) => record.serviceCount)).size, 1000)
  logger.write({
    action: 'resolve',
    event: 'complete',
    operationId: '0123456789abcdef',
    alreadyImported: true
  })
  await logger.flush()
  records = (await readFile(filePath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(records.length, 1001)
  assert.equal(records.at(-1).alreadyImported, true)
})

test('invalid required enums and nonexact request identifiers cannot create a diagnostic event', () => {
  const base = { action: 'list', event: 'start', operationId: '0123456789abcdef' }
  for (const value of [
    null,
    [],
    'private',
    9,
    {},
    { ...base, action: 'private-token' },
    { ...base, event: 'complete\nprivate' },
    { ...base, operationId: 'user@example.com' },
    { ...base, operationId: '0123456789abcdef\n' },
    { ...base, operationId: '0123456789abcde' }
  ]) {
    assert.equal(sanitizeServiceDiagnostic(value), undefined)
  }
  assert.deepEqual(
    sanitizeServiceDiagnostic({
      ...base,
      requestId: 'fedcba9876543210\n',
      pluginVersion: '1.0.3\n'
    }),
    base
  )
})

test('optional fields reject arbitrary strings, invalid flags and unbounded or negative numbers', () => {
  const base = { action: 'list', event: 'response', operationId: '0123456789abcdef' }
  const sanitized = sanitizeServiceDiagnostic({
    ...base,
    stage: 'private-stage',
    durationMs: Infinity,
    httpStatus: 600,
    contentType: 'application/json; private=token',
    pluginVersion: '1.0.3-private@example.com',
    requestId: 'private-request-id',
    error: 'private-error-body',
    serviceCount: -1,
    importedCount: Number.MAX_SAFE_INTEGER + 1,
    alreadyImported: 'true',
    timedOut: 1,
    diagnostic: 'user@example.com',
    query: {
      version: 1,
      reason: 'unavailable',
      clientCount: -1,
      ownedServices: Infinity,
      activeServices: 1.5,
      allowedServices: 1_000_001,
      allowedProductIds: ['private']
    }
  })
  assert.deepEqual(sanitized, { ...base, query: { version: 1, reason: 'unavailable' } })
  for (const query of [
    { version: 2, reason: 'unavailable' },
    { version: 1, reason: 'private' },
    null,
    []
  ])
    assert.deepEqual(sanitizeServiceDiagnostic({ ...base, query }), base)
  assert.deepEqual(
    sanitizeServiceDiagnostic({
      ...base,
      durationMs: 0,
      httpStatus: 100,
      serviceCount: 0,
      importedCount: 0,
      timedOut: false,
      alreadyImported: true
    }),
    {
      ...base,
      durationMs: 0,
      httpStatus: 100,
      serviceCount: 0,
      importedCount: 0,
      timedOut: false,
      alreadyImported: true
    }
  )
})

test('query product IDs are positive safe integers with at most one hundred entries', () => {
  const base = { action: 'list', event: 'complete', operationId: '0123456789abcdef' }
  const query = { version: 1, reason: 'product-not-enabled' }
  for (const allowedProductIds of [
    Array(101).fill(1),
    [0],
    [-1],
    [1.5],
    [NaN],
    [Number.MAX_SAFE_INTEGER + 1],
    ['123']
  ])
    assert.deepEqual(
      sanitizeServiceDiagnostic({ ...base, query: { ...query, allowedProductIds } }),
      { ...base, query }
    )
  const allowedProductIds = Array.from({ length: 100 }, (_, index) => index + 1)
  const output = sanitizeServiceDiagnostic({ ...base, query: { ...query, allowedProductIds } })!
  allowedProductIds[0] = 9999
  assert.equal(output.query!.allowedProductIds!.length, 100)
  assert.equal(output.query!.allowedProductIds![0], 1)
})

test('all current resolve failure codes and legacy identity codes are retained as fixed diagnostics', () => {
  const base = { action: 'resolve', event: 'failed', operationId: '0123456789abcdef' }
  for (const diagnostic of [
    'client-uuid-not-found',
    'client-uuid-matches-user',
    'client-uuid-ambiguous',
    'client-uuid-mismatch',
    'client-closed',
    'client-status-unknown',
    'user-uuid-not-found',
    'user-uuid-ambiguous',
    'user-uuid-mismatch',
    'owned-client-limit',
    'no-owned-accessible-client',
    'invalid-client-mapping',
    'service-owner-mismatch',
    'service-not-active',
    'client-inactive',
    'no-owned-active-client',
    'whmcs-service-unavailable',
    'whmcs-service-changed',
    'remnawave-user-not-found',
    'remnawave-id-mismatch',
    'remnawave-user-inactive',
    'remnawave-user-expired',
    'remnawave-expiry-invalid',
    'remnawave-response-invalid',
    'remnawave-access-denied',
    'remnawave-subscription-missing',
    'remnawave-request-failed',
    'remnawave-subscription-invalid',
    'remnawave-configuration-error'
  ])
    assert.deepEqual(sanitizeServiceDiagnostic({ ...base, diagnostic }), { ...base, diagnostic })
})

test('sanitization ignores inherited fields, accessors and serialization hooks', () => {
  let called = false
  const base = { action: 'resolve', event: 'failed', operationId: '0123456789abcdef' }
  const payload = Object.assign(Object.create({ error: 'access-denied' }), base)
  Object.defineProperty(payload, 'diagnostic', {
    get() {
      called = true
      throw Error('private')
    }
  })
  payload.toJSON = () => {
    called = true
    return { token: 'private' }
  }
  assert.deepEqual(sanitizeServiceDiagnostic(payload), base)
  assert.equal(called, false)
  assert.equal(sanitizeServiceDiagnostic(Object.create(base)), undefined)
})

test('filesystem failures never throw or log errors and later writes recover after the path is repaired', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'koala-diagnostics-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parent = join(root, 'blocked')
  await writeFile(parent, 'leave-existing-content-alone')
  const filePath = join(parent, 'whmcs-services.log')
  const logger = createServiceDiagnostics({
    filePath: () => filePath,
    appVersion: () => 'private app/path/token'
  })
  const event: ServiceDiagnostic = {
    action: 'resolve',
    event: 'failed',
    operationId: '0123456789abcdef',
    error: 'service-unavailable'
  }
  const original = console.error
  let errors = 0
  console.error = () => {
    errors++
  }
  try {
    assert.doesNotThrow(() => logger.write(event))
    await logger.flush()
    assert.equal(await readFile(parent, 'utf8'), 'leave-existing-content-alone')
    await rm(parent)
    logger.write(event)
    await logger.flush()
    const raw = await readFile(filePath, 'utf8')
    assert.equal(JSON.parse(raw).appVersion, 'unknown')
    assert(!raw.includes('private'))
    assert.equal(errors, 0)
  } finally {
    console.error = original
  }
})

test(
  'a symlink log target is not followed or overwritten',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'koala-diagnostics-link-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const target = join(root, 'other-data')
    const filePath = join(root, 'whmcs-services.log')
    await writeFile(target, 'keep-existing-data')
    await symlink(target, filePath)
    const logger = createServiceDiagnostics({ filePath: () => filePath, appVersion: () => '1.4.3' })
    const event: ServiceDiagnostic = {
      action: 'bind',
      event: 'start',
      operationId: '0123456789abcdef'
    }
    logger.write(event)
    await logger.flush()
    assert.equal(await readFile(target, 'utf8'), 'keep-existing-data')
    await rm(filePath)
    logger.write(event)
    await logger.flush()
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).action, 'bind')
  }
)
