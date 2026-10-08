import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { resolveBundledWhmcsSecret } from '../scripts/whmcs-build-config'

const sample = 'synthetic-test-secret+/=never-real'

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'koala-build-secret-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.secrets'))
  return {
    root,
    defaultFile: join(root, '.secrets', 'whmcs-client-secret.txt'),
    file: (name: string, contents: string | Buffer, mode = 0o600): string => {
      const path = join(root, name)
      writeFileSync(path, contents, { mode })
      chmodSync(path, mode)
      return path
    },
    resolve: (env: Record<string, string | undefined> = {}) =>
      resolveBundledWhmcsSecret({ root, env })
  }
}

function safeFailure(action: () => unknown, forbidden: string[]): Error {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error, 'Expected a controlled error')
  assert.match(caught.message, /^WHMCS login /)
  assert.equal(caught.cause, undefined)
  for (const value of forbidden) {
    assert.ok(!String(caught).includes(value), 'Error must not include a private path or value')
  }
  return caught
}

test('explicit environment secret wins over both file settings without touching them', (t) => {
  const f = fixture(t)
  f.file('.secrets/whmcs-client-secret.txt', 'default-value')
  const configured = f.resolve({
    KOALA_WHMCS_CLIENT_SECRET: `  ${sample}\n`,
    KOALA_WHMCS_CLIENT_SECRET_FILE: '/does-not-exist/private-value.txt'
  })
  assert.equal(configured, sample)
})

test('an explicitly empty or invalid environment secret never falls back to a file', (t) => {
  const f = fixture(t)
  f.file('.secrets/whmcs-client-secret.txt', sample)
  for (const value of ['', ' \n\t', 'embedded space', 'bad\nsecret', '密钥', 'x'.repeat(4097)]) {
    safeFailure(() => f.resolve({ KOALA_WHMCS_CLIENT_SECRET: value }), [sample, f.root])
  }
})

test('explicit secret file wins over default and relative paths resolve from the project root', (t) => {
  const f = fixture(t)
  f.file('.secrets/whmcs-client-secret.txt', 'default-secret')
  const explicit = f.file('release-secret.txt', `${sample}\r\n`)
  assert.equal(f.resolve({ KOALA_WHMCS_CLIENT_SECRET_FILE: explicit }), sample)
  assert.equal(f.resolve({ KOALA_WHMCS_CLIENT_SECRET_FILE: 'release-secret.txt' }), sample)
})

test('missing or empty default supports ordinary builds while required login fails closed', (t) => {
  const f = fixture(t)
  assert.equal(f.resolve(), undefined)
  assert.equal(f.resolve({ KOALA_REQUIRE_WHMCS_LOGIN: '0' }), undefined)
  safeFailure(() => f.resolve({ KOALA_REQUIRE_WHMCS_LOGIN: '1' }), [f.root])
  f.file('.secrets/whmcs-client-secret.txt', ' \r\n\t', 0o644)
  assert.equal(f.resolve(), undefined, 'An empty placeholder contains no secret')
  safeFailure(() => f.resolve({ KOALA_REQUIRE_WHMCS_LOGIN: '1' }), [f.root])
})

test('default private file provides a trimmed secret without modifying it', (t) => {
  const f = fixture(t)
  const original = `\r\n${sample}\n`
  f.file('.secrets/whmcs-client-secret.txt', original)
  assert.equal(f.resolve(), sample)
  assert.equal(readFileSync(f.defaultFile, 'utf8'), original)
})

test('explicit missing, empty and malformed file settings are controlled errors', (t) => {
  const f = fixture(t)
  f.file('.secrets/whmcs-client-secret.txt', sample)
  const empty = f.file('empty.txt', '\n')
  for (const file of ['', '  ', 'absent.txt', empty, `private-${sample}\0`]) {
    safeFailure(() => f.resolve({ KOALA_WHMCS_CLIENT_SECRET_FILE: file }), [sample, f.root])
  }
})

test('files must be regular files rather than directories or symbolic links', (t) => {
  const f = fixture(t)
  const target = f.file('private.txt', sample)
  mkdirSync(join(f.root, 'directory'))
  safeFailure(() => f.resolve({ KOALA_WHMCS_CLIENT_SECRET_FILE: 'directory' }), [sample, f.root])
  if (process.platform === 'win32') return
  symlinkSync(target, join(f.root, 'alias.txt'))
  safeFailure(() => f.resolve({ KOALA_WHMCS_CLIENT_SECRET_FILE: 'alias.txt' }), [sample, f.root])
  symlinkSync(join(f.root, 'missing-target'), f.defaultFile)
  safeFailure(() => f.resolve(), [sample, f.root])
})

test('POSIX secret files accept 0600 and 0400 but reject group, other and execute permissions', (t) => {
  if (process.platform === 'win32')
    return t.skip('POSIX permission bits do not describe Windows ACLs')
  const f = fixture(t)
  const path = f.file('.secrets/whmcs-client-secret.txt', sample)
  for (const mode of [0o600, 0o400]) {
    chmodSync(path, mode)
    assert.equal(f.resolve(), sample)
  }
  for (const mode of [0o644, 0o640, 0o604, 0o700, 0o660]) {
    chmodSync(path, mode)
    safeFailure(() => f.resolve(), [sample, f.root])
  }
})

test('file reads and secret values have independent size bounds', (t) => {
  const f = fixture(t)
  f.file('.secrets/whmcs-client-secret.txt', 'x'.repeat(4096))
  assert.equal(f.resolve()?.length, 4096)
  f.file('.secrets/whmcs-client-secret.txt', 'x'.repeat(4097))
  safeFailure(() => f.resolve(), [f.root])
  f.file('.secrets/whmcs-client-secret.txt', ' '.repeat(16 * 1024 - sample.length) + sample)
  assert.equal(f.resolve(), sample)
  f.file('.secrets/whmcs-client-secret.txt', ' '.repeat(16 * 1024 + 1))
  safeFailure(() => f.resolve(), [f.root])
})

test('invalid UTF-8 and nonprintable content never enters a JavaScript bundle', (t) => {
  const f = fixture(t)
  for (const contents of [
    Buffer.from([0xc0, 0xaf]),
    'inside\0nul',
    'inside\ttab',
    'inside\x7fdel'
  ]) {
    f.file('.secrets/whmcs-client-secret.txt', contents)
    safeFailure(() => f.resolve(), [f.root])
  }
})

test('interior spaces in a file fail the required-login build while surrounding whitespace is trimmed', (t) => {
  const f = fixture(t)
  f.file('.secrets/whmcs-client-secret.txt', 'embedded space')
  safeFailure(() => f.resolve({ KOALA_REQUIRE_WHMCS_LOGIN: '1' }), [f.root])
  f.file('.secrets/whmcs-client-secret.txt', ` \t${sample}\r\n`)
  assert.equal(f.resolve({ KOALA_REQUIRE_WHMCS_LOGIN: '1' }), sample)
})

test('the resolver never writes to console or includes the selected filename in errors', (t) => {
  const f = fixture(t)
  const log = t.mock.method(console, 'log', () => undefined)
  const warn = t.mock.method(console, 'warn', () => undefined)
  const error = t.mock.method(console, 'error', () => undefined)
  f.file('.secrets/whmcs-client-secret.txt', sample)
  assert.equal(f.resolve(), sample)
  safeFailure(
    () => f.resolve({ KOALA_WHMCS_CLIENT_SECRET_FILE: `missing-${sample}.txt` }),
    [sample, f.root]
  )
  assert.equal(log.mock.callCount(), 0)
  assert.equal(warn.mock.callCount(), 0)
  assert.equal(error.mock.callCount(), 0)
})
