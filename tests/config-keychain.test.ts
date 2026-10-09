import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { parse, stringify } from 'yaml'
import { deepMerge } from '../src/main/utils/merge'
import { loadMainModule } from './helpers/load-main-module'
import * as fsPromises from 'node:fs/promises'

function fixture(t: TestContext, withSecrets = true) {
  const directory = mkdtempSync(join(tmpdir(), 'koala-keychain-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'app.yaml')
  const encode = (value: string) => `enc:${Buffer.from(value).toString('base64')}`
  const initial = {
    sysProxy: { enable: false },
    theme: 'dark',
    ...(withSecrets
      ? { serviceAuthKey: encode('public:private'), systemCorePath: encode('/test/mihomo') }
      : {})
  }
  writeFileSync(file, stringify(initial))
  let available = true
  let failDecrypt = false
  let accesses = 0
  let beforeRead = async (): Promise<void> => {}
  const crypto = loadMainModule(new URL('../src/main/utils/encrypt.ts', import.meta.url), {
    electron: {
      safeStorage: {
        isEncryptionAvailable() {
          accesses++
          return available
        },
        encryptString(value: string) {
          accesses++
          return Buffer.from(value)
        },
        decryptString(value: Buffer) {
          accesses++
          if (failDecrypt) throw new Error('Keychain access denied')
          return value.toString()
        }
      }
    },
    './i18n': { t: (key: string) => key }
  })
  const api = loadMainModule(new URL('../src/main/config/app.ts', import.meta.url), {
    'fs/promises': {
      ...fsPromises,
      readFile: async (...args: Parameters<typeof fsPromises.readFile>) => {
        const content = await fsPromises.readFile(...args)
        await beforeRead()
        return content
      }
    },
    '../utils/dirs': { appConfigPath: () => file },
    '../utils/yaml': { parseYaml: parse, stringifyYaml: stringify },
    '../utils/merge': { deepMerge },
    '../utils/template': { defaultConfig: { sysProxy: {} } },
    '../utils/encrypt': crypto
  })
  return {
    api,
    crypto,
    initial,
    file,
    disk: () => parse(readFileSync(file, 'utf8')),
    accesses: () => accesses,
    deny: () => {
      available = false
    },
    allow: () => {
      available = true
      failDecrypt = false
    },
    failDecrypt: () => {
      failDecrypt = true
    },
    beforeRead: (callback: typeof beforeRead) => {
      beforeRead = callback
    }
  }
}

test('startup settings reads and ordinary writes never access Keychain or expose secrets', async (t) => {
  const f = fixture(t)
  for (const config of [f.api.getAppConfigSync(), await f.api.getAppConfig()]) {
    assert.equal(config.serviceAuthKey, undefined)
    assert.equal(config.systemCorePath, undefined)
  }
  await f.api.patchAppConfig({ theme: 'light', sysProxy: { enable: true } })
  assert.equal(f.accesses(), 0)
  assert.equal(f.disk().serviceAuthKey, f.initial.serviceAuthKey)
  assert.equal(f.disk().systemCorePath, f.initial.systemCorePath)
  assert.equal(f.disk().theme, 'light')
})

test('explicit secret use decrypts only the requested field and caches successful reads', async (t) => {
  const f = fixture(t)
  assert.equal(await f.api.getAppConfigSecret('serviceAuthKey'), 'public:private')
  const calls = f.accesses()
  assert.ok(calls > 0)
  assert.equal(await f.api.getAppConfigSecret('serviceAuthKey'), 'public:private')
  await f.api.patchAppConfig({ theme: 'light' })
  assert.equal(f.accesses(), calls)
  assert.equal(f.api.getAppConfigSecretSync('systemCorePath'), '/test/mihomo')
  const pathCalls = f.accesses()
  assert.equal(f.api.getAppConfigSecretSync('systemCorePath'), '/test/mihomo')
  assert.equal(f.accesses(), pathCalls)
})

test('denied decryption keeps ciphertext intact and a later explicit read can retry', async (t) => {
  const f = fixture(t)
  f.failDecrypt()
  await assert.rejects(() => f.api.getAppConfigSecret('serviceAuthKey'))
  await f.api.patchAppConfig({ theme: 'light' })
  assert.equal(f.disk().serviceAuthKey, f.initial.serviceAuthKey)
  f.allow()
  assert.equal(await f.api.getAppConfigSecret('serviceAuthKey'), 'public:private')
})

test('denied secret writes are atomic and do not block later ordinary settings writes', async (t) => {
  const f = fixture(t)
  f.deny()
  await assert.rejects(() =>
    f.api.patchAppConfig({ serviceAuthKey: 'new:key', sysProxy: { enable: true } })
  )
  assert.equal(f.disk().serviceAuthKey, f.initial.serviceAuthKey)
  assert.equal((await f.api.getAppConfig()).sysProxy.enable, false)
  await f.api.patchAppConfig({ theme: 'light' })
  assert.equal(f.disk().theme, 'light')
  assert.equal(f.disk().serviceAuthKey, f.initial.serviceAuthKey)
})

test('missing or explicitly cleared secrets never request Keychain access', async (t) => {
  const f = fixture(t, false)
  assert.equal(await f.api.getAppConfigSecret('serviceAuthKey'), '')
  assert.equal(f.api.getAppConfigSecretSync('systemCorePath'), '')
  await f.api.patchAppConfig({ serviceAuthKey: '' })
  assert.equal(f.accesses(), 0)
})

test('encryption unavailability never returns plaintext or encoded ciphertext as a secret', (t) => {
  const f = fixture(t)
  f.deny()
  assert.throws(() => f.crypto.encryptString('private'))
  assert.throws(() => f.crypto.decryptString(f.initial.serviceAuthKey))
})

test('an older startup read cannot roll back a newly saved service key', async (t) => {
  const f = fixture(t)
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const reading = new Promise<void>((resolve) => {
    entered = resolve
  })
  let reads = 0
  f.beforeRead(async () => {
    if (++reads === 1) {
      entered()
      await blocked
    }
  })
  const startup = f.api.getAppConfig()
  await reading
  const save = f.api.patchAppConfig({ serviceAuthKey: 'new:key', theme: 'light' })
  // Allow a concurrent, uncoordinated read/write to finish before releasing the stale read.
  await new Promise((resolve) => setTimeout(resolve, 30))
  release()
  await Promise.all([startup, save])
  await f.api.patchAppConfig({ maxLogDays: 8 })
  assert.equal(await f.api.getAppConfigSecret('serviceAuthKey'), 'new:key')
  assert.equal(f.disk().theme, 'light')
})

test('forced configuration reloads serialize with protected settings writes', async (t) => {
  const f = fixture(t)
  await f.api.getAppConfig()
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const reading = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.beforeRead(async () => {
    entered()
    await blocked
  })
  const reload = f.api.getAppConfig(true)
  await reading
  const save = f.api.patchAppConfig({ serviceAuthKey: 'new:key', theme: 'light' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  release()
  await Promise.all([reload, save])
  await f.api.patchAppConfig({ maxLogDays: 8 })
  assert.equal(await f.api.getAppConfigSecret('serviceAuthKey'), 'new:key')
  assert.equal(f.disk().theme, 'light')
})
