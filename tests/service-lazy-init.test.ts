import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const requireModule = createRequire(import.meta.url)

function loadModule(file: string, mocks: Record<string, unknown>, globals = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  // Compiled fixture modules expose different function and constructor signatures.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const module = { exports: {} as Record<string, (...args: any[]) => any> }
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    Buffer,
    process,
    setTimeout,
    ...globals,
    require: (name: string) => (name in mocks ? mocks[name] : requireModule(name))
  })
  return module.exports
}

function serviceFixture() {
  const counts = {
    secretReads: 0,
    regularReads: 0,
    generated: 0,
    saved: 0,
    clients: 0,
    elevated: 0
  }
  let secret = ''
  let readSecret = async () => secret
  let saveSecret = async (): Promise<void> => {}
  let elevate = async (): Promise<void> => {}
  const managerExports: Record<string, unknown> = {}
  const i18n = { t: (key: string) => key }
  const keyModule = loadModule('src/main/service/key.ts', { '../utils/i18n': i18n })
  const RealKeyManager = keyModule.KeyManager
  class KeyManager extends RealKeyManager {
    generateKeyPair() {
      counts.generated++
      return super.generateKeyPair()
    }
  }
  const requests: Array<{ method: string; route: string; body: unknown; signed: boolean }> = []
  const api = loadModule('src/main/service/api.ts', {
    './key': { KeyManager },
    './manager': managerExports,
    '../utils/dirs': { serviceIpcPath: () => '/fixture/service.sock' },
    '../utils/i18n': i18n,
    axios: {
      create: () => {
        counts.clients++
        let sign = (config: { headers: Record<string, string> }) => config
        const request = async (method: string, route: string, body?: unknown) => {
          const config = sign({ headers: {} })
          requests.push({ method, route, body, signed: !!config.headers['X-Signature'] })
          return { status: 'ok' }
        }
        return {
          interceptors: {
            request: {
              use: (callback: typeof sign) => {
                sign = callback
              }
            },
            response: { use: () => {} }
          },
          get: (route: string) => request('GET', route),
          post: (route: string, body?: unknown) => request('POST', route, body)
        }
      }
    }
  })
  const configApi = {
    getAppConfig: async () => {
      counts.regularReads++
      return { serviceAuthKey: secret }
    },
    getAppConfigSecret: async (field: string) => {
      assert.equal(field, 'serviceAuthKey')
      counts.secretReads++
      return readSecret()
    },
    patchAppConfig: async (patch: { serviceAuthKey: string }) => {
      counts.saved++
      await saveSecret()
      secret = patch.serviceAuthKey
    }
  }
  const manager = loadModule(
    'src/main/service/manager.ts',
    {
      './key': { KeyManager },
      './api': api,
      '../utils/dirs': { servicePath: () => '/fixture/service' },
      '../utils/i18n': i18n,
      '../utils/elevation': {
        execWithElevation: async () => {
          counts.elevated++
          await elevate()
        }
      },
      '../config': configApi,
      '../config/app': configApi
    },
    { setTimeout: (callback: () => void) => callback() }
  )
  Object.assign(managerExports, manager)
  return {
    counts,
    requests,
    api,
    manager,
    createSecret: () => {
      const pair = new RealKeyManager().generateKeyPair()
      return `${pair.publicKey}:${pair.privateKey}`
    },
    setSecret: (value: string) => {
      secret = value
    },
    readSecret: (callback: typeof readSecret) => {
      readSecret = callback
    },
    saveSecret: (callback: typeof saveSecret) => {
      saveSecret = callback
    },
    elevate: (callback: typeof elevate) => {
      elevate = callback
    }
  }
}

test('ordinary startup never initializes, reads or generates a helper-service key', async () => {
  let keyInitializations = 0
  const proxyChanges: boolean[] = []
  const config = { sysProxy: { enable: true, settingMode: 'exec' }, proxyMode: false }
  const startup = loadModule('src/main/utils/init.ts', {
    './dirs': new Proxy({}, { get: () => () => '/fixture' }),
    './template': { defaultConfig: config, defaultControledMihomoConfig: {} },
    './yaml': {},
    'fs/promises': { readdir: async () => [] },
    fs: { existsSync: () => true },
    '../resolve/server': { startPacServer: async () => {} },
    '../sys/sysproxy': { triggerSysProxy: async (enabled: boolean) => proxyChanges.push(enabled) },
    '../config': {
      getAppConfig: async () => config,
      getControledMihomoConfig: async () => ({ 'external-controller': '' })
    },
    electron: { app: { setAsDefaultProtocolClient: () => {} } },
    '../sys/ssid': { startSSIDCheck: async () => {} },
    '../core/manager': {},
    '../service/manager': {
      initKeyManager: async () => {
        keyInitializations++
      }
    },
    './migration': { migrateFromOldApp: async () => {} }
  })
  await startup.init()
  assert.equal(keyInitializations, 0)
  assert.deepEqual(proxyChanges, [false])
})

test('concurrent service operations initialize once on demand and all requests are signed', async () => {
  const f = serviceFixture()
  assert.deepEqual(f.counts, {
    secretReads: 0,
    regularReads: 0,
    generated: 0,
    saved: 0,
    clients: 0,
    elevated: 0
  })
  await Promise.all([
    f.api.test(),
    f.api.setProxy('127.0.0.1:7897', 'localhost', '', true),
    f.manager.exportPublicKey()
  ])
  assert.deepEqual(f.counts, {
    secretReads: 1,
    regularReads: 0,
    generated: 1,
    saved: 1,
    clients: 1,
    elevated: 0
  })
  assert.equal(f.requests.length, 2)
  assert(f.requests.every((request) => request.signed))
  await f.api.ping()
  assert.equal(f.counts.secretReads, 1)
  assert.equal(f.counts.generated, 1)
})

test('an existing service key is read explicitly and reused without regeneration or a config write', async () => {
  const f = serviceFixture()
  f.setSecret(f.createSecret())
  await f.api.getCoreStatus()
  assert.equal(f.counts.secretReads, 1)
  assert.equal(f.counts.regularReads, 0)
  assert.equal(f.counts.generated, 0)
  assert.equal(f.counts.saved, 0)
  assert.equal(f.requests[0].signed, true)
})

test('a denied secret read fails concurrent requests without caching or replacing a key and can be retried', async () => {
  const f = serviceFixture()
  f.readSecret(async () => {
    throw Error('secret read denied')
  })
  await Promise.all([
    assert.rejects(f.api.test(), /secret read denied/),
    assert.rejects(f.manager.exportPublicKey(), /secret read denied/)
  ])
  assert.equal(f.counts.secretReads, 1)
  assert.equal(f.counts.generated, 0)
  assert.equal(f.counts.saved, 0)
  assert.equal(f.counts.clients, 0)
  assert.throws(() => f.manager.getKeyManager())
  const existing = f.createSecret()
  f.readSecret(async () => existing)
  await f.api.test()
  assert.equal(f.counts.secretReads, 2)
  assert.equal(f.counts.generated, 0)
  assert.equal(f.requests[0].signed, true)
})

test('malformed stored service keys are rejected without being replaced', async () => {
  for (const stored of ['invalid', 'public:invalid private key']) {
    const f = serviceFixture()
    f.setSecret(stored)
    await assert.rejects(f.api.test())
    assert.equal(f.counts.generated, 0)
    assert.equal(f.counts.saved, 0)
    assert.equal(f.counts.clients, 0)
    assert.throws(() => f.manager.getKeyManager())
  }
})

test('failed secure persistence never publishes a generated service key and a later attempt retries', async () => {
  const f = serviceFixture()
  f.saveSecret(async () => {
    throw Error('secure write denied')
  })
  await assert.rejects(f.api.test(), /secure write denied/)
  assert.equal(f.counts.clients, 0)
  assert.equal(f.requests.length, 0)
  assert.throws(() => f.manager.getKeyManager())
  assert.throws(() => f.api.getKeyManager())
  f.saveSecret(async () => {})
  await f.api.test()
  assert.equal(f.counts.secretReads, 2)
  assert.equal(f.counts.generated, 2)
  assert.equal(f.counts.clients, 1)
  assert.equal(f.requests[0].signed, true)
})

test('failed explicit service initialization preserves the last usable manager and API', async () => {
  const f = serviceFixture()
  await f.api.test()
  const previous = await f.manager.exportPublicKey()
  f.elevate(async () => {
    throw Error('User canceled. (-128)')
  })
  await assert.rejects(f.manager.initService(), /error.userCancelled/)
  assert.equal(await f.manager.exportPublicKey(), previous)
  assert.equal(f.counts.saved, 1)
  assert.equal(f.counts.clients, 1)
  await f.api.test()
  assert.equal(f.requests.length, 2)
})

test('explicit service initialization never changes the helper key if secure persistence is denied', async () => {
  const f = serviceFixture()
  f.saveSecret(async () => {
    throw Error('secure write denied')
  })
  await assert.rejects(f.manager.initService(), /secure write denied/)
  assert.equal(f.counts.elevated, 0)
  assert.equal(f.counts.clients, 0)
  assert.throws(() => f.manager.getKeyManager())
})

test('concurrent explicit initialization and API calls wait for one helper initialization using the existing key', async () => {
  const f = serviceFixture()
  const existing = f.createSecret()
  f.setSecret(existing)
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.elevate(async () => {
    entered()
    await gate
  })
  const first = f.manager.initService()
  await started
  const second = f.manager.initService()
  const request = f.api.test()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.requests.length, 0)
  release()
  await Promise.all([first, second, request])
  assert.equal(await f.manager.exportPublicKey(), existing.split(':')[0])
  assert.deepEqual(f.counts, {
    secretReads: 1,
    regularReads: 0,
    generated: 0,
    saved: 0,
    clients: 1,
    elevated: 1
  })
  assert.equal(f.requests[0].signed, true)
})

test('installing a helper without making a service request does not read or generate a key', async () => {
  const f = serviceFixture()
  await f.manager.installService()
  assert.equal(f.counts.elevated, 1)
  assert.equal(f.counts.secretReads, 0)
  assert.equal(f.counts.generated, 0)
  assert.equal(f.counts.clients, 0)
})

for (const [platform, settingMode, mode, needsService] of [
  ['darwin', 'exec', 'manual', false],
  ['darwin', 'service', 'manual', true],
  ['darwin', 'service', 'auto', true],
  ['win32', 'service', 'manual', false],
  ['linux', 'service', 'manual', false]
] as const) {
  test(`${platform} ${settingMode} ${mode} proxy uses the existing platform route and initializes keys only for service requests`, async () => {
    const f = serviceFixture()
    const executed: string[][] = []
    const proxy = loadModule(
      'src/main/sys/sysproxy.ts',
      {
        '../config': {
          getAppConfig: async () => ({ sysProxy: { settingMode, mode } }),
          getControledMihomoConfig: async () => ({ 'mixed-port': 7897 })
        },
        '../resolve/server': {
          startPacServer: async () => {},
          stopPacServer: async () => {},
          pacPort: 1234
        },
        child_process: {
          execFile: (
            _file: string,
            args: string[],
            callback: (error: null, stdout: string) => void
          ) => {
            executed.push(args)
            callback(null, '')
          }
        },
        '../utils/dirs': { servicePath: () => '/fixture/service' },
        electron: { net: { isOnline: () => true } },
        '../service/api': f.api,
        '../utils/i18n': { t: (key: string) => key }
      },
      { process: { platform } }
    )
    await proxy.triggerSysProxy(true, true)
    await proxy.triggerSysProxy(false, true)
    assert.equal(f.counts.secretReads, needsService ? 1 : 0)
    assert.equal(f.requests.length, needsService ? 2 : 0)
    assert.equal(executed.length, needsService ? 0 : 2)
    if (needsService) {
      assert.equal(f.requests[0].route, mode === 'auto' ? '/sysproxy/pac' : '/sysproxy/proxy')
      assert.equal(f.requests[1].route, '/sysproxy/disable')
      assert(f.requests.every((request) => request.signed))
    }
  })
}
