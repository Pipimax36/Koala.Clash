import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createClientSecretLoader } from '../src/main/auth/client-secret'

const fixtureSecret = 'test-client-secret+/='

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'koala-secret-'))
  const values = new Map<string, string>()
  const crypto = {
    isAvailable: () => true,
    encrypt: (value: string): Buffer => {
      const key = randomBytes(32)
      values.set(key.toString('hex'), value)
      return key
    },
    decrypt: (value: Buffer): string => {
      const secret = values.get(value.toString('hex'))
      if (secret === undefined) throw new Error('private decryption failure')
      return secret
    }
  }
  return {
    directory,
    options: { filePath: join(directory, 'auth', 'client-secret.enc'), crypto },
    cleanup: () => rm(directory, { recursive: true, force: true })
  }
}

test('a provisioned secret survives restart without putting it in the encrypted file as plaintext', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const load = createClientSecretLoader({ ...f.options, environmentSecret: fixtureSecret })
  assert.deepEqual(await Promise.all([load(), load()]), [fixtureSecret, fixtureSecret])
  const stored = await readFile(f.options.filePath, 'utf8')
  assert.ok(!stored.includes(fixtureSecret))
  assert.ok(!stored.includes(Buffer.from(fixtureSecret).toString('base64')))
  assert.equal(await createClientSecretLoader(f.options)(), fixtureSecret)
  if (process.platform !== 'win32')
    assert.equal((await stat(f.options.filePath)).mode & 0o777, 0o600)
})

test('imports from an explicitly selected private file, retaining the user-owned original', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const sourceFile = join(f.directory, 'secret.txt')
  await writeFile(sourceFile, fixtureSecret + '\n', { mode: 0o600 })
  assert.equal(await createClientSecretLoader({ ...f.options, sourceFile })(), fixtureSecret)
  assert.equal(await readFile(sourceFile, 'utf8'), fixtureSecret + '\n')
  assert.equal(await createClientSecretLoader(f.options)(), fixtureSecret)
})

test('unavailable OS encryption allows an explicitly provisioned memory-only secret', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const options = {
    ...f.options,
    crypto: { ...f.options.crypto, isAvailable: () => false }
  }
  assert.equal(
    await createClientSecretLoader({ ...options, environmentSecret: fixtureSecret })(),
    fixtureSecret
  )
  await assert.rejects(readFile(f.options.filePath), { code: 'ENOENT' })
  await assert.rejects(createClientSecretLoader(options)(), { message: 'configuration-error' })
})

test('missing, corrupt, oversize or public-readable credentials produce controlled errors', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await assert.rejects(createClientSecretLoader(f.options)(), { message: 'configuration-error' })
  for (const environmentSecret of ['', 'embedded\nnewline', 'x'.repeat(4097)]) {
    await assert.rejects(createClientSecretLoader({ ...f.options, environmentSecret })(), {
      message: 'configuration-error'
    })
  }
  const sourceFile = join(f.directory, 'secret.txt')
  await writeFile(sourceFile, 'x'.repeat(20_000), { mode: 0o600 })
  await assert.rejects(createClientSecretLoader({ ...f.options, sourceFile })(), {
    message: 'configuration-error'
  })
  if (process.platform !== 'win32') {
    const publicFile = join(f.directory, 'public.txt')
    await writeFile(publicFile, fixtureSecret, { mode: 0o644 })
    await assert.rejects(createClientSecretLoader({ ...f.options, sourceFile: publicFile })(), {
      message: 'configuration-error'
    })
  }
  await createClientSecretLoader({ ...f.options, environmentSecret: fixtureSecret })()
  await writeFile(f.options.filePath, 'invalid envelope')
  await assert.rejects(createClientSecretLoader(f.options)(), { message: 'configuration-error' })
})

test('a failed credential read can be retried after the private file is provided', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const sourceFile = join(f.directory, 'secret.txt')
  const load = createClientSecretLoader({ ...f.options, sourceFile })
  await assert.rejects(load(), { message: 'configuration-error' })
  await writeFile(sourceFile, fixtureSecret, { mode: 0o600 })
  assert.equal(await load(), fixtureSecret)
})

test('an installed build loads its bundled credential without configuration, disk writes, or OS encryption', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const failIfCalled = (): never => {
    throw new Error('Bundled credentials must not use OS encryption')
  }
  const load = createClientSecretLoader({
    ...f.options,
    bundledSecret: fixtureSecret,
    crypto: { isAvailable: failIfCalled, encrypt: failIfCalled, decrypt: failIfCalled }
  })
  assert.deepEqual(await Promise.all([load(), load()]), [fixtureSecret, fixtureSecret])
  await assert.rejects(readFile(f.options.filePath), { code: 'ENOENT' })
})

test('a rotated bundled credential overrides an older encrypted cache without rewriting it', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await createClientSecretLoader({ ...f.options, environmentSecret: 'old-credential' })()
  const original = await readFile(f.options.filePath)
  assert.equal(
    await createClientSecretLoader({ ...f.options, bundledSecret: 'rotated-credential' })(),
    'rotated-credential'
  )
  assert.deepEqual(await readFile(f.options.filePath), original)
  assert.equal(await createClientSecretLoader(f.options)(), 'old-credential')
})

test('explicit environment and file overrides take precedence over the bundled credential', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const sourceFile = join(f.directory, 'override.txt')
  await writeFile(sourceFile, 'file-credential\n', { mode: 0o600 })
  const options = { ...f.options, sourceFile, bundledSecret: 'bundled-credential' }
  assert.equal(
    await createClientSecretLoader({ ...options, environmentSecret: 'environment-credential' })(),
    'environment-credential'
  )
  assert.equal(await createClientSecretLoader(options)(), 'file-credential')
})

test('invalid explicit overrides and invalid bundled credentials fail instead of using a lower-priority value', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await createClientSecretLoader({ ...f.options, environmentSecret: 'cached-credential' })()
  for (const environmentSecret of ['', 'invalid\ncredential', 'x'.repeat(4097)]) {
    await assert.rejects(
      createClientSecretLoader({ ...f.options, bundledSecret: fixtureSecret, environmentSecret })(),
      { message: 'configuration-error' }
    )
  }
  await assert.rejects(
    createClientSecretLoader({
      ...f.options,
      bundledSecret: fixtureSecret,
      sourceFile: join(f.directory, 'missing.txt')
    })(),
    { message: 'configuration-error' }
  )
  for (const bundledSecret of ['', 'nonASCII-密钥', 'invalid\ncredential', 'x'.repeat(4097)]) {
    await assert.rejects(createClientSecretLoader({ ...f.options, bundledSecret })(), {
      message: 'configuration-error'
    })
  }
})
