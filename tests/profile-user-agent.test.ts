import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import packageInfo from '../package.json'
import { parseYaml, stringifyYaml } from '../src/main/utils/yaml'
import { loadMainModule } from './helpers/load-main-module'

const subscriptionUrl = 'https://subscription.example.test/api/v1/client/subscribe'
const legacySubscription = `proxies:
  - name: Fixture SS
    type: ss
    server: ss.example.test
    port: 443
    cipher: aes-128-gcm
    password: fixture-password
`
const metaSubscription = `${legacySubscription}  - name: Fixture AnyTLS
    type: anytls
    server: anytls.example.test
    port: 443
    password: fixture-password
`

async function fixture(
  globalUserAgent?: string,
  coreVersion: string | Error = 'v1.19.31',
  responseHeaders: Record<string, string> = {}
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'koala-profile-ua-test-'))
  const profilePath = (id: string) => path.join(directory, `${id}.yaml`)
  await writeFile(path.join(directory, 'profiles.yaml'), 'items: []\n')

  const appConfig = { userAgent: globalUserAgent }
  const getAppConfig = async () => appConfig
  let coreVersionReads = 0
  const mihomoVersion = async () => {
    coreVersionReads++
    if (coreVersion instanceof Error) throw coreVersion
    return { version: coreVersion, meta: true }
  }
  // Load the real functions under test. Only the filesystem location, HTTP response,
  // and unavailable Electron/runtime boundaries are substituted.
  const userAgent = loadMainModule(new URL('../src/main/utils/userAgent.ts', import.meta.url), {
    '../config': { getAppConfig },
    '../core/mihomoApi': { mihomoVersion }
  })
  const requests: string[] = []
  const profile = loadMainModule(new URL('../src/main/config/profile.ts', import.meta.url), {
    '../utils/dirs': {
      profileConfigPath: () => path.join(directory, 'profiles.yaml'),
      profilePath
    },
    '../core/manager': {},
    '../core/factory': { getRuntimeConfig: async () => ({}) },
    '../core/mihomoApi': {},
    './app': { getAppConfig },
    './controledMihomo': {},
    electron: { ipcMain: { emit: () => {} } },
    '..': {},
    axios: {
      get: async (url: string, options: { headers: Record<string, string> }) => {
        assert.equal(url, subscriptionUrl)
        const agent = options.headers['User-Agent']
        requests.push(agent)
        return {
          data: /meta/i.test(agent) ? metaSubscription : legacySubscription,
          headers: { 'content-type': 'text/yaml', ...responseHeaders }
        }
      }
    },
    '../utils/yaml': { parseYaml, stringifyYaml },
    '../utils/template': { defaultProfile: {} },
    '../utils/merge': {},
    '../utils/userAgent': { getUserAgent: userAgent.getUserAgent },
    '../utils/deviceInfo': {
      getHWID: () => 'fixture-hwid',
      getDeviceOS: () => 'fixture-os',
      getOSVersion: () => 'fixture-version',
      getDeviceModel: () => 'fixture-model'
    },
    '../utils/i18n': { t: (key: string) => key },
    '../resolve/theme': {}
  })

  return {
    appConfig,
    getUserAgent: userAgent.getUserAgent as () => Promise<string>,
    createProfile: profile.createProfile as (item: Partial<ProfileItem>) => Promise<ProfileItem>,
    requests,
    getCoreVersionReads: () => coreVersionReads,
    profilePath,
    cleanup: () => rm(directory, { recursive: true, force: true })
  }
}

test('new remote profiles default to 24-hour updates without changing explicit or existing settings', async () => {
  const f = await fixture()
  try {
    const created = await f.createProfile({ type: 'remote', url: subscriptionUrl })
    assert.equal(created.autoUpdate, true)
    assert.equal(created.interval, 24 * 60)

    const explicitZero = await f.createProfile({
      type: 'remote',
      url: subscriptionUrl,
      interval: 0
    })
    assert.equal(explicitZero.interval, 0)

    const existingDisabled = await f.createProfile({
      id: 'existing-disabled',
      type: 'remote',
      url: subscriptionUrl,
      autoUpdate: false,
      interval: 0
    })
    assert.equal(existingDisabled.autoUpdate, false)
    assert.equal(existingDisabled.interval, 0)

    const existingCustom = await f.createProfile({
      id: 'existing-custom',
      type: 'remote',
      url: subscriptionUrl,
      interval: 180
    })
    assert.equal(existingCustom.interval, 180)
  } finally {
    await f.cleanup()
  }
})

test('subscription update interval header overrides the new default and remains locked', async () => {
  const f = await fixture(undefined, 'v1.19.31', { 'profile-update-interval': '6' })
  try {
    const created = await f.createProfile({ type: 'remote', url: subscriptionUrl })
    assert.equal(created.interval, 6 * 60)
    assert.equal(created.locked, true)
  } finally {
    await f.cleanup()
  }
})

test('default subscription User-Agent requests the AnyTLS-capable Mihomo YAML', async () => {
  const f = await fixture()
  try {
    const item = await f.createProfile({
      id: 'default-agent',
      type: 'remote',
      url: subscriptionUrl
    })
    assert.equal(item.ua, undefined)
    assert.equal(f.requests[0], await f.getUserAgent())
    assert.equal(f.requests[0], `clash.meta/1.19.31 koala-clash/${packageInfo.version}`)
    const saved = parseYaml<{ proxies: { type: string }[] }>(
      await readFile(f.profilePath(item.id), 'utf8')
    )
    assert.deepEqual(
      saved.proxies.map((proxy) => proxy.type),
      ['ss', 'anytls']
    )
  } finally {
    await f.cleanup()
  }
})

test('global custom User-Agent is sent unchanged for a remote subscription', async () => {
  const customAgent = 'Custom Meta Client/7.2 (fixture)'
  const f = await fixture(customAgent)
  try {
    const item = await f.createProfile({
      id: 'global-agent',
      type: 'remote',
      url: subscriptionUrl
    })
    assert.equal(await f.getUserAgent(), customAgent)
    assert.deepEqual(f.requests, [customAgent])
    assert.equal(f.getCoreVersionReads(), 0)
    const saved = parseYaml<{ proxies: { type: string }[] }>(
      await readFile(f.profilePath(item.id), 'utf8')
    )
    assert.equal(saved.proxies[1].type, 'anytls')
  } finally {
    await f.cleanup()
  }
})

test('subscription User-Agent overrides the global value and keeps its exact spelling', async () => {
  const f = await fixture('Global Meta Client/7.2')
  const subscriptionAgent = 'Subscription MeTa Client/8.4 (fixture)'
  try {
    const item = await f.createProfile({
      id: 'subscription-agent',
      type: 'remote',
      url: subscriptionUrl,
      ua: subscriptionAgent
    })
    assert.equal(item.ua, subscriptionAgent)
    assert.deepEqual(f.requests, [subscriptionAgent])
    assert.equal(f.getCoreVersionReads(), 0)
    const saved = parseYaml<{ proxies: { type: string }[] }>(
      await readFile(f.profilePath(item.id), 'utf8')
    )
    assert.equal(saved.proxies[1].type, 'anytls')
  } finally {
    await f.cleanup()
  }
})

for (const coreVersion of [new Error('core offline'), 'alpha-1234567']) {
  test(`unavailable or unrecognized core version uses the unversioned Meta agent: ${String(coreVersion)}`, async () => {
    const f = await fixture(undefined, coreVersion)
    try {
      const item = await f.createProfile({
        id: 'fallback-agent',
        type: 'remote',
        url: subscriptionUrl
      })
      assert.deepEqual(f.requests, ['clash.meta (koala-clash)'])
      assert.equal(f.getCoreVersionReads(), 1)
      const saved = parseYaml<{ proxies: { type: string }[] }>(
        await readFile(f.profilePath(item.id), 'utf8')
      )
      assert.equal(saved.proxies[1].type, 'anytls')
    } finally {
      await f.cleanup()
    }
  })
}
