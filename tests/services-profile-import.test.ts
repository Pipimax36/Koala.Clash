import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { parse, stringify } from 'yaml'
import { deepMerge } from '../src/main/utils/merge'
import {
  ServiceRequestError,
  serviceProfileId,
  type ServiceImport
} from '../src/main/auth/services'

const requireModule = createRequire(import.meta.url)
const source = fs.readFileSync(path.resolve(__dirname, '../src/main/config/profile.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true
  }
}).outputText
const yaml = 'proxies: []\nproxy-groups: []\nrules: []\n'

type AppSettingsApi = {
  getAppConfig(): Promise<AppConfig>
  patchAppConfig(
    patch: Partial<AppConfig>,
    shouldApply?: (current: Readonly<AppConfig>) => boolean
  ): Promise<void>
}

function appSettingsQueue(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-app-settings-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  const configFile = path.join(directory, 'app.yaml')
  fs.writeFileSync(configFile, stringify({ sysProxy: {}, customTheme: 'manual.css' }))
  let beforeWrite = async (_content: string): Promise<void> => {}
  const appSource = fs.readFileSync(path.resolve(__dirname, '../src/main/config/app.ts'), 'utf8')
  const appCompiled = ts.transpileModule(appSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} as AppSettingsApi }
  const mocks: Record<string, unknown> = {
    'fs/promises': {
      ...fsPromises,
      writeFile: async (...args: Parameters<typeof fsPromises.writeFile>) => {
        await beforeWrite(String(args[1]))
        return fsPromises.writeFile(...args)
      }
    },
    '../utils/dirs': { appConfigPath: () => configFile },
    '../utils/yaml': { parseYaml: parse, stringifyYaml: stringify },
    '../utils/merge': { deepMerge },
    '../utils/template': { defaultConfig: { sysProxy: {} } },
    '../utils/encrypt': {}
  }
  vm.runInNewContext(appCompiled, {
    module,
    exports: module.exports,
    process,
    require: (name: string) => (name in mocks ? mocks[name] : requireModule(name))
  })
  return {
    api: module.exports,
    beforeWrite: (callback: typeof beforeWrite) => {
      beforeWrite = callback
    }
  }
}

function fixture(t: TestContext, items: ProfileItem[] = [], current?: string, appApi?: AppSettingsApi) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-service-import-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  const configFile = path.join(directory, 'profile.yaml')
  const profileFile = (id: string) => path.join(directory, `${id}.yaml`)
  fs.writeFileSync(configFile, stringify({ current, items }))
  for (const item of items) fs.writeFileSync(profileFile(item.id), `original-${item.id}`)
  let valid = true
  let failCommit = false
  let beforeWrite = async (): Promise<void> => {
    /* No pending filesystem work by default. */
  }
  let fetchProfile = async () => ({ data: yaml, headers: { 'content-type': 'application/yaml' } })
  const downloads: string[] = []
  const activated: string[] = []
  let activate = async (): Promise<void> => {}
  let appConfig = async (): Promise<Record<string, unknown>> => ({})
  const appSettings: Partial<AppConfig> = {}
  const controlledSettings: Partial<MihomoConfig> = { mode: 'global' }
  let afterAppPatch = async (_patch: Partial<AppConfig>): Promise<void> => {}
  let corePatch = async (): Promise<void> => {}
  let beforeControlledRead = async (): Promise<void> => {}
  let failNotifications = false
  const events: string[] = []
  const module = { exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>> }
  const mocks: Record<string, unknown> = {
    'fs/promises': {
      ...fsPromises,
      writeFile: async (...args: Parameters<typeof fsPromises.writeFile>) => {
        await beforeWrite()
        return fsPromises.writeFile(...args)
      }
    },
    fs: {
      ...fs,
      renameSync: (from: string, to: string) => {
        if (failCommit && to === configFile) throw Error('write failed')
        fs.renameSync(from, to)
      }
    },
    '../utils/dirs': { profileConfigPath: () => configFile, profilePath: profileFile },
    '../auth/services': { ServiceRequestError },
    '../core/manager': {
      restartCore: async (throwOnError?: boolean) => {
        assert.equal(throwOnError, true)
        activated.push('restart')
        await activate()
      }
    },
    '../core/factory': { getRuntimeConfig: async () => ({}) },
    '../core/mihomoApi': {
      mihomoHotReloadConfig: async () => {
        activated.push('reload')
        await activate()
      },
      patchMihomoConfig: () => corePatch()
    },
    './app': {
      getAppConfig: async () => ({ ...appSettings, ...(await appConfig()) }),
      patchAppConfig: async (
        patch: Partial<AppConfig>,
        shouldApply?: (current: Readonly<AppConfig>) => boolean
      ) => {
        if (shouldApply && !shouldApply(appSettings as AppConfig)) return
        Object.assign(appSettings, patch)
        await afterAppPatch(patch)
      }
    },
    './controledMihomo': {
      getControledMihomoConfig: async () => {
        await beforeControlledRead()
        return { ...controlledSettings }
      },
      patchControledMihomoConfig: async (patch: Partial<MihomoConfig>) => {
        Object.assign(controlledSettings, patch)
      }
    },
    electron: { ipcMain: { emit: (event: string) => events.push(event) } },
    '..': {
      mainWindow: {
        webContents: {
          send: (event: string) => {
            if (failNotifications) throw Error('renderer destroyed')
            events.push(event)
          }
        }
      }
    },
    axios: {
      get: async (url: string) => {
        downloads.push(url)
        return fetchProfile()
      },
      isAxiosError: () => false
    },
    '../utils/yaml': { parseYaml: parse, stringifyYaml: stringify },
    '../utils/template': { defaultProfile: {} },
    '../utils/merge': {},
    '../utils/userAgent': { getUserAgent: async () => 'Koala-test' },
    '../utils/deviceInfo': {
      getHWID: () => 'test',
      getDeviceOS: () => 'test',
      getOSVersion: () => 'test',
      getDeviceModel: () => 'test'
    },
    '../utils/i18n': { t: (value: string) => value },
    '../resolve/theme': {
      downloadCustomCss: () => {
        throw Error('must not download assets while staging')
      }
    }
  }
  if (appApi) mocks['./app'] = appApi
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    Buffer,
    URL,
    console,
    require: (name: string) => (name in mocks ? mocks[name] : requireModule(name))
  })
  const request: ServiceImport = {
    id: 72,
    name: 'Service 72',
    identity: 'user-a',
    profileId: serviceProfileId('user-a', 72),
    subscriptionUrl: 'https://subscription.example/72',
    assertCurrent() {
      if (!valid) throw new ServiceRequestError('session-changed')
    }
  }
  return {
    request,
    downloads,
    activated,
    onActivate: (callback: typeof activate) => {
      activate = callback
    },
    appConfig: (callback: typeof appConfig) => {
      appConfig = callback
    },
    appSettings,
    controlledSettings,
    afterAppPatch: (callback: typeof afterAppPatch) => {
      afterAppPatch = callback
    },
    corePatch: (callback: typeof corePatch) => {
      corePatch = callback
    },
    beforeControlledRead: (callback: typeof beforeControlledRead) => {
      beforeControlledRead = callback
    },
    failNotifications: () => {
      failNotifications = true
    },
    events,
    directory,
    profileFile,
    import: (value = request) => module.exports.importServiceProfile(value),
    config: (): ProfileConfig => parse(fs.readFileSync(configFile, 'utf8')),
    expire: () => {
      valid = false
    },
    failCommit: () => {
      failCommit = true
    },
    fetch: (fn: typeof fetchProfile) => {
      fetchProfile = fn
    },
    create: (item: ProfileItem) => module.exports.createProfile(item),
    update: (item: ProfileItem) => module.exports.updateProfileItem(item),
    set: (config: ProfileConfig) => module.exports.setProfileConfig(config),
    select: (id: string) => module.exports.changeCurrentProfile(id),
    beforeWrite: (callback: typeof beforeWrite) => {
      beforeWrite = callback
    }
  }
}

test('explicit import preserves manual content and activates the imported subscription in the core', async (t) => {
  const f = fixture(t, [{ id: 'manual', type: 'local', name: 'My configuration' }], 'manual')
  assert.deepEqual(JSON.parse(JSON.stringify(await f.import())), {
    profileId: f.request.profileId,
    alreadyImported: false
  })
  assert.equal(f.config().current, f.request.profileId)
  assert.equal(f.config().items.length, 2)
  assert.equal(fs.readFileSync(f.profileFile('manual'), 'utf8'), 'original-manual')
  assert.equal(fs.readFileSync(f.profileFile(f.request.profileId), 'utf8'), yaml)
  assert.deepEqual(f.activated, ['reload'])
  assert.deepEqual(f.config().items[1].whmcsServices, [{ identity: 'user-a', serviceId: 72 }])
})

test('first explicit import into an empty app activates the subscription', async (t) => {
  const f = fixture(t)
  await f.import()
  assert.equal(f.config().current, f.request.profileId)
  assert.deepEqual(f.activated, ['reload'])
})

test('activation failure restores the previous selection and core while retaining the import for retry', async (t) => {
  const f = fixture(t, [{ id: 'manual', type: 'local', name: 'Manual' }], 'manual')
  const coreSelections: Array<string | undefined> = []
  f.onActivate(async () => {
    coreSelections.push(f.config().current)
    if (coreSelections.length === 1) throw new Error('private core failure')
  })
  await assert.rejects(f.import(), { reason: 'activation-failed', message: 'activation-failed' })
  assert.equal(f.config().current, 'manual')
  assert.deepEqual(coreSelections, [f.request.profileId, 'manual'])
  assert.equal(f.config().items.length, 2)
  assert.equal(fs.readFileSync(f.profileFile(f.request.profileId), 'utf8'), yaml)
  assert(f.events.includes('profileConfigUpdated'))
  assert(f.events.includes('updateTrayMenu'))
  await f.import()
  assert.equal(f.config().current, f.request.profileId)
  assert.equal(f.config().items.length, 2)
})

test('failed mode enforcement restores the previous global mode before reloading the old subscription', async (t) => {
  const f = fixture(t, [{ id: 'manual', type: 'local', name: 'Manual' }], 'manual')
  f.fetch(async () => ({
    data: yaml,
    headers: { 'content-type': 'application/yaml', 'global-mode': 'false' }
  }))
  const loadedModes: Array<string | undefined> = []
  f.onActivate(async () => {
    loadedModes.push(f.controlledSettings.mode)
  })
  f.corePatch(async () => {
    throw Error('core mode patch failed')
  })
  await assert.rejects(f.import(), { reason: 'activation-failed' })
  assert.equal(f.config().current, 'manual')
  assert.equal(f.controlledSettings.mode, 'global')
  assert.deepEqual(loadedModes, ['global', 'global'])
  assert(f.events.includes('controledMihomoConfigUpdated'))
})

test('logout during a theme write restores both app settings before reloading the previous subscription', async (t) => {
  const f = fixture(
    t,
    [
      { id: 'manual', type: 'local', name: 'Manual' },
      {
        id: 'target',
        type: 'remote',
        name: 'Imported subscription',
        url: 'https://subscription.example/72',
        expandProxyGroups: true,
        customCss: 'target.css'
      }
    ],
    'manual'
  )
  Object.assign(f.appSettings, { expandProxyGroups: false, customTheme: 'manual.css' })
  const loadedSettings: Array<Partial<AppConfig>> = []
  f.onActivate(async () => {
    loadedSettings.push({ ...f.appSettings })
  })
  f.afterAppPatch(async (patch) => {
    if (patch.customTheme === 'target.css') f.expire()
  })
  await assert.rejects(f.import(), { reason: 'session-changed' })
  assert.equal(f.config().current, 'manual')
  assert.deepEqual(f.appSettings, { expandProxyGroups: false, customTheme: 'manual.css' })
  assert.deepEqual(loadedSettings, [
    { expandProxyGroups: false, customTheme: 'manual.css' },
    { expandProxyGroups: false, customTheme: 'manual.css' }
  ])
  assert(f.events.includes('appConfigUpdated'))
})

test('rollback preserves mode and app settings changed independently after activation wrote them', async (t) => {
  const f = fixture(
    t,
    [
      { id: 'manual', type: 'local', name: 'Manual' },
      {
        id: 'target',
        type: 'remote',
        name: 'Imported subscription',
        url: 'https://subscription.example/72',
        globalMode: false,
        customCss: 'target.css'
      }
    ],
    'manual'
  )
  f.appSettings.customTheme = 'manual.css'
  f.afterAppPatch(async (patch) => {
    if (patch.customTheme !== 'target.css') return
    f.appSettings.customTheme = 'new-choice.css'
    f.appSettings.expandProxyGroups = true
    f.controlledSettings.mode = 'direct'
    f.expire()
  })
  await assert.rejects(f.import(), { reason: 'session-changed' })
  assert.equal(f.config().current, 'manual')
  assert.equal(f.controlledSettings.mode, 'direct')
  assert.deepEqual(f.appSettings, { customTheme: 'new-choice.css', expandProxyGroups: true })
})

test('rollback cannot overwrite a newer theme already waiting in the real app settings write queue', async (t) => {
  const queued = appSettingsQueue(t)
  let targetStarted!: () => void
  const started = new Promise<void>((resolve) => {
    targetStarted = resolve
  })
  let releaseTarget!: () => void
  const targetGate = new Promise<void>((resolve) => {
    releaseTarget = resolve
  })
  let releaseBlocker!: () => void
  const blockerGate = new Promise<void>((resolve) => {
    releaseBlocker = resolve
  })
  let rollbackQueued!: () => void
  const rollback = new Promise<void>((resolve) => {
    rollbackQueued = resolve
  })
  queued.beforeWrite(async (content) => {
    const next = parse(content)
    if (next.customTheme !== 'target.css') return
    if (next.expandProxyGroups === false) {
      await blockerGate
    } else {
      targetStarted()
      await targetGate
    }
  })
  const f = fixture(
    t,
    [
      { id: 'manual', type: 'local', name: 'Manual' },
      {
        id: 'target',
        type: 'remote',
        name: 'Imported subscription',
        url: 'https://subscription.example/72',
        customCss: 'target.css'
      }
    ],
    'manual',
    {
      getAppConfig: queued.api.getAppConfig,
      patchAppConfig: (patch, shouldApply) => {
        if (patch.customTheme === 'manual.css') rollbackQueued()
        return queued.api.patchAppConfig(patch, shouldApply)
      }
    }
  )
  const importing = assert.rejects(f.import(), { reason: 'session-changed' })
  await started
  const blocker = queued.api.patchAppConfig({ expandProxyGroups: false })
  const newerChoice = queued.api.patchAppConfig({ customTheme: 'new-choice.css' })
  f.expire()
  releaseTarget()
  await rollback
  releaseBlocker()
  await Promise.all([importing, blocker, newerChoice])
  assert.equal(f.config().current, 'manual')
  assert.equal((await queued.api.getAppConfig()).customTheme, 'new-choice.css')
})

test('logout while an activation setting waits in the real write queue prevents its write without blocking future settings', async (t) => {
  const queued = appSettingsQueue(t)
  await queued.api.getAppConfig()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  queued.beforeWrite(async () => {
    await gate
  })
  const blocker = queued.api.patchAppConfig({ expandProxyGroups: false })
  let themeQueued!: () => void
  const waiting = new Promise<void>((resolve) => {
    themeQueued = resolve
  })
  const f = fixture(t, [{ id: 'manual', type: 'local', name: 'Manual' }], 'manual', {
    getAppConfig: queued.api.getAppConfig,
    patchAppConfig: (patch, shouldApply) => {
      if (patch.customTheme === 'default.css') themeQueued()
      return queued.api.patchAppConfig(patch, shouldApply)
    }
  })
  const importing = assert.rejects(f.import(), { reason: 'session-changed' })
  await waiting
  f.expire()
  release()
  await Promise.all([blocker, importing])
  assert.equal(f.config().current, 'manual')
  assert.equal((await queued.api.getAppConfig()).customTheme, 'manual.css')
  await queued.api.patchAppConfig({ customTheme: 'new-choice.css' })
  assert.equal((await queued.api.getAppConfig()).customTheme, 'new-choice.css')
})

for (const targetSettings of [{ expandProxyGroups: true }, { customCss: 'target.css' }]) {
  test(`logout while reading ${Object.keys(targetSettings)[0]} prevents its setting write`, async (t) => {
    const f = fixture(
      t,
      [
        { id: 'manual', type: 'local', name: 'Manual' },
        {
          id: 'target',
          type: 'remote',
          name: 'Imported subscription',
          url: 'https://subscription.example/72',
          ...targetSettings
        }
      ],
      'manual'
    )
    let reads = 0
    f.appConfig(async () => {
      if (++reads === 2) f.expire()
      return {}
    })
    const writes: Array<Partial<AppConfig>> = []
    f.afterAppPatch(async (patch) => {
      writes.push(patch)
    })
    await assert.rejects(f.import(), { reason: 'session-changed' })
    assert.equal(f.config().current, 'manual')
    assert.deepEqual(writes, [])
  })
}

test('logout while reading the core mode prevents mode enforcement', async (t) => {
  const f = fixture(t, [{ id: 'manual', type: 'local', name: 'Manual' }], 'manual')
  f.fetch(async () => ({
    data: yaml,
    headers: { 'content-type': 'application/yaml', 'global-mode': 'false' }
  }))
  f.beforeControlledRead(async () => {
    f.expire()
  })
  let modePatches = 0
  f.corePatch(async () => {
    modePatches++
  })
  await assert.rejects(f.import(), { reason: 'session-changed' })
  assert.equal(f.config().current, 'manual')
  assert.equal(f.controlledSettings.mode, 'global')
  assert.equal(modePatches, 0)
})

test('a closed renderer cannot turn a successful activation into a failed import', async (t) => {
  const f = fixture(t)
  f.failNotifications()
  await f.import()
  assert.equal(f.config().current, f.request.profileId)
  assert.deepEqual(f.activated, ['reload'])
  assert(f.events.includes('updateTrayMenu'))
})

test('logout before activation leaves the saved subscription inactive', async (t) => {
  const f = fixture(t, [{ id: 'manual', type: 'local', name: 'Manual' }], 'manual')
  f.appConfig(async () => {
    f.expire()
    return {}
  })
  await assert.rejects(f.import(), { reason: 'session-changed' })
  assert.equal(f.config().current, 'manual')
  assert.deepEqual(f.activated, [])
})

test('logout during core activation restores the previous selection and loaded configuration', async (t) => {
  const f = fixture(t, [{ id: 'manual', type: 'local', name: 'Manual' }], 'manual')
  const coreSelections: Array<string | undefined> = []
  f.onActivate(async () => {
    coreSelections.push(f.config().current)
    f.expire()
  })
  await assert.rejects(f.import(), { reason: 'session-changed' })
  assert.equal(f.config().current, 'manual')
  assert.deepEqual(coreSelections, [f.request.profileId, 'manual'])
})

test('activation uses the configured restart strategy with startup failures propagated', async (t) => {
  const f = fixture(t)
  f.appConfig(async () => ({ useHotReloadProfile: false }))
  f.onActivate(async () => {
    throw Error('core startup failed')
  })
  await assert.rejects(f.import(), { reason: 'activation-failed' })
  assert.equal(f.config().current, undefined)
  assert.deepEqual(f.activated, ['restart', 'restart'])
  f.onActivate(async () => {})
  await f.import()
  assert.equal(f.config().current, f.request.profileId)
})

test('manual selection waits for import activation and cannot be overwritten by its rollback', async (t) => {
  const f = fixture(t, [{ id: 'manual', type: 'local', name: 'Manual' }], 'manual')
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let calls = 0
  f.onActivate(async () => {
    if (++calls !== 1) return
    entered()
    await gate
    throw Error('activation failed')
  })
  const importing = assert.rejects(f.import(), { reason: 'activation-failed' })
  await started
  const manual = f.select('manual')
  release()
  await Promise.all([importing, manual])
  assert.equal(f.config().current, 'manual')
  assert.equal(calls, 3)
})

test('repeat import updates the same bound profile, including a rotated URL', async (t) => {
  const f = fixture(t)
  await f.import()
  f.fetch(async () => ({
    data: 'proxies: []\nrules: [MATCH,DIRECT]\n',
    headers: { 'content-type': 'application/yaml' }
  }))
  const result = await f.import({
    ...f.request,
    subscriptionUrl: 'https://subscription.example/rotated'
  })
  assert.equal((result as { alreadyImported: boolean }).alreadyImported, true)
  assert.equal(f.config().items.length, 1)
  assert.equal(f.config().items[0].url, 'https://subscription.example/rotated')
  assert.deepEqual(f.activated, ['reload', 'reload'])
})

test('same URL manual profile is associated without downloading or overwriting its content or settings', async (t) => {
  const manual: ProfileItem = {
    id: 'manual',
    type: 'remote',
    name: 'Custom name',
    url: 'https://subscription.example/72',
    interval: 7,
    autoUpdate: false
  }
  const f = fixture(t, [manual], 'manual')
  await f.import()
  assert.equal(f.config().items.length, 1)
  const { whmcsServices, ...unchanged } = f.config().items[0]
  assert.deepEqual(unchanged, manual)
  assert.equal(whmcsServices?.[0].serviceId, 72)
  assert.equal(fs.readFileSync(f.profileFile('manual'), 'utf8'), 'original-manual')
  assert.deepEqual(f.downloads, [])
  await f.import()
  assert.equal(f.config().items[0].whmcsServices?.length, 1)
})

test('another account binding is never reused or overwritten for a coincident subscription URL', async (t) => {
  const other: ProfileItem = {
    id: 'other',
    type: 'remote',
    name: 'Other account',
    url: 'https://subscription.example/72',
    whmcsServices: [{ identity: 'user-b', serviceId: 72 }]
  }
  const f = fixture(t, [other], 'other')
  await assert.rejects(f.import(), { reason: 'import-failed' })
  assert.deepEqual(f.config().items, [other])
  assert.equal(fs.readFileSync(f.profileFile('other'), 'utf8'), 'original-other')
})

test('logout during subscription download prevents every profile/config write', async (t) => {
  const f = fixture(t, [{ id: 'manual', type: 'local', name: 'Manual' }], 'manual')
  f.fetch(async () => {
    f.expire()
    return { data: yaml, headers: { 'content-type': 'application/yaml' } }
  })
  await assert.rejects(f.import(), { reason: 'session-changed' })
  assert.equal(f.config().items.length, 1)
  assert.equal(fs.existsSync(f.profileFile(f.request.profileId)), false)
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['manual.yaml', 'profile.yaml'])
  assert.deepEqual(f.activated, [])
})

test('invalid subscription content leaves existing configurations untouched', async (t) => {
  const f = fixture(t)
  f.fetch(async () => ({ data: 'not a configuration', headers: { 'content-type': 'text/html' } }))
  await assert.rejects(f.import())
  assert.deepEqual(f.config().items, [])
  assert.equal(fs.existsSync(f.profileFile(f.request.profileId)), false)
})

test('failed config commit rolls back a newly staged profile and removes temporary files', async (t) => {
  const f = fixture(t)
  f.failCommit()
  await assert.rejects(f.import(), { reason: 'import-failed' })
  assert.deepEqual(f.config().items, [])
  assert.deepEqual(fs.readdirSync(f.directory), ['profile.yaml'])
})

test('ordinary profile refresh retains service ownership metadata', async (t) => {
  const f = fixture(t)
  await f.import()
  const refreshed = (await f.create(f.config().items[0])) as ProfileItem
  assert.deepEqual(JSON.parse(JSON.stringify(refreshed.whmcsServices)), [
    { identity: 'user-a', serviceId: 72 }
  ])
})

test('one service cannot take over a different managed service that resolves to the same URL', async (t) => {
  const f = fixture(t)
  await f.import()
  await assert.rejects(
    f.import({ ...f.request, id: 73, profileId: serviceProfileId('user-a', 73) }),
    { reason: 'import-failed' }
  )
  assert.equal(f.config().items.length, 1)
  assert.deepEqual(f.config().items[0].whmcsServices, [{ identity: 'user-a', serviceId: 72 }])
})

test('a rotated service URL leaves an associated manual configuration intact and creates a managed profile', async (t) => {
  const f = fixture(
    t,
    [{ id: 'manual', type: 'remote', name: 'Manual', url: 'https://subscription.example/72' }],
    'manual'
  )
  await f.import()
  await f.import({ ...f.request, subscriptionUrl: 'https://subscription.example/new' })
  assert.equal(f.config().items.length, 2)
  assert.equal(f.config().items[0].url, 'https://subscription.example/72')
  assert.deepEqual(f.config().items[0].whmcsServices, [])
  assert.equal(fs.readFileSync(f.profileFile('manual'), 'utf8'), 'original-manual')
  assert.equal(f.config().current, f.request.profileId)
})

test('an edit made while downloading a managed refresh wins over the obsolete import', async (t) => {
  const f = fixture(t)
  await f.import()
  const existing = f.config().items[0]
  f.fetch(async () => {
    await f.update({ ...existing, name: 'Edited during download' })
    return {
      data: 'proxies: []\nrules: [new-rule]',
      headers: { 'content-type': 'application/yaml' }
    }
  })
  await assert.rejects(f.import(), { reason: 'import-failed' })
  assert.equal(f.config().items[0].name, 'Edited during download')
  assert.equal(fs.readFileSync(f.profileFile(f.request.profileId), 'utf8'), yaml)
})

test('a failed refresh commit restores the previous managed profile bytes', async (t) => {
  const f = fixture(t)
  await f.import()
  f.fetch(async () => ({
    data: 'proxies: []\nrules: [new-rule]',
    headers: { 'content-type': 'application/yaml' }
  }))
  f.failCommit()
  await assert.rejects(f.import(), { reason: 'import-failed' })
  assert.equal(fs.readFileSync(f.profileFile(f.request.profileId), 'utf8'), yaml)
  assert.equal(f.config().items.length, 1)
  assert.equal(fs.readdirSync(f.directory).filter((name) => name.endsWith('.tmp')).length, 0)
})

test('an old asynchronous config write cannot overwrite a completed import binding', async (t) => {
  const manual: ProfileItem = {
    id: 'manual',
    type: 'remote',
    name: 'Manual',
    url: 'https://subscription.example/72'
  }
  const f = fixture(t, [manual], 'manual')
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  f.beforeWrite(async () => {
    started()
    await gate
  })
  const oldWrite = f.set({ current: 'manual', items: [{ ...manual, name: 'Updated name' }] })
  await entered
  let completed = false
  const importing = f.import().then((value) => {
    completed = true
    return value
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, false, 'Import must wait for the already-started config write')
  const newestWrite = f.set({ current: 'manual', items: [{ ...manual, name: 'Newest name' }] })
  release()
  await Promise.all([oldWrite, newestWrite, importing])
  assert.equal(f.config().items[0].name, 'Newest name')
  assert.deepEqual(f.config().items[0].whmcsServices, [{ identity: 'user-a', serviceId: 72 }])
})

test('a manual same-URL profile added during download is reused at commit instead of duplicated', async (t) => {
  const f = fixture(t)
  f.fetch(async () => {
    fs.writeFileSync(f.profileFile('manual'), 'manually-created-content')
    await f.set({
      current: 'manual',
      items: [
        {
          id: 'manual',
          name: 'Manual during download',
          type: 'remote',
          url: f.request.subscriptionUrl
        }
      ]
    })
    return { data: yaml, headers: { 'content-type': 'application/yaml' } }
  })
  const result = (await f.import()) as { profileId: string }
  assert.equal(result.profileId, 'manual')
  assert.equal(f.config().items.length, 1)
  assert.equal(f.config().current, 'manual')
  assert.equal(fs.readFileSync(f.profileFile('manual'), 'utf8'), 'manually-created-content')
  assert.equal(fs.existsSync(f.profileFile(f.request.profileId)), false)
  assert.deepEqual(f.config().items[0].whmcsServices, [{ identity: 'user-a', serviceId: 72 }])
})

test('a different-account same-URL profile added during download is not replaced or duplicated', async (t) => {
  const f = fixture(t)
  f.fetch(async () => {
    await f.set({
      items: [
        {
          id: 'foreign',
          type: 'remote',
          name: 'Another account',
          url: f.request.subscriptionUrl,
          whmcsServices: [{ identity: 'user-b', serviceId: 72 }]
        }
      ]
    })
    return { data: yaml, headers: { 'content-type': 'application/yaml' } }
  })
  await assert.rejects(f.import(), { reason: 'import-failed' })
  assert.equal(f.config().items.length, 1)
  assert.equal(f.config().items[0].id, 'foreign')
  assert.equal(fs.existsSync(f.profileFile(f.request.profileId)), false)
})
