import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deepMerge } from '../src/main/utils/merge'
import { parseYaml, stringifyYaml } from '../src/main/utils/yaml'
import { loadMainModule } from './helpers/load-main-module'

async function generatedTun(
  platform: NodeJS.Platform,
  controlTun: boolean,
  subscriptionTun: Partial<MihomoTunConfig> | undefined,
  selectedStack: TunStack = 'mixed'
): Promise<MihomoTunConfig | undefined> {
  const subscription = {
    'log-level': 'info',
    ...(subscriptionTun ? { tun: { ...subscriptionTun } } : {})
  }
  const controlled = {
    tun: { enable: true, stack: selectedStack, 'auto-route': true },
    'mixed-port': 7897
  }
  let written = ''
  const factory = loadMainModule(
    new URL('../src/main/core/factory.ts', import.meta.url),
    {
      '../config': {
        getProfileConfig: async () => ({ current: 'fixture' }),
        getAppConfig: async () => ({ controlTun }),
        getProfile: async () => subscription,
        getProfileStr: async () => stringifyYaml(subscription),
        getControledMihomoConfig: async () => controlled
      },
      '../utils/dirs': {
        rulePath: () => '/fixture/rules.yaml',
        mihomoWorkConfigPath: () => '/fixture/work.yaml'
      },
      '../utils/yaml': { parseYaml, stringifyYaml },
      '../utils/merge': { deepMerge },
      fs: { existsSync: () => false },
      'fs/promises': {
        writeFile: async (_path: string, content: string) => {
          written = content
        }
      }
    },
    { process: { platform } }
  )
  await factory.generateProfile()
  const runtime = await factory.getRuntimeConfig()
  // Assert the same effective configuration reaches both hot reload and startup YAML.
  assert.deepEqual(parseYaml<MihomoConfig>(written).tun, JSON.parse(JSON.stringify(runtime.tun)))
  return runtime.tun
}

test('macOS automatic TUN replaces a subscription Mixed stack with the working gVisor stack', async () => {
  const tun = await generatedTun('darwin', false, {
    stack: 'mixed',
    'auto-route': true,
    mtu: 1500,
    'dns-hijack': ['any:53']
  })
  assert.equal(tun?.stack, 'gvisor')
  assert.equal(tun?.enable, true)
  assert.equal(tun?.mtu, 1500)
  assert.deepEqual(Array.from(tun?.['dns-hijack'] ?? []), ['any:53'])
})

test('macOS automatic TUN also migrates an old Mixed default when the subscription has no TUN section', async () => {
  assert.equal((await generatedTun('darwin', false, undefined))?.stack, 'gvisor')
})

test('macOS manual TUN respects the explicitly selected stack', async () => {
  for (const stack of ['mixed', 'system', 'gvisor'] as const) {
    assert.equal((await generatedTun('darwin', true, { stack: 'gvisor' }, stack))?.stack, stack)
  }
})

for (const platform of ['win32', 'linux'] as const) {
  test(`${platform} automatic TUN preserves the subscription stack`, async () => {
    for (const stack of ['mixed', 'system', 'gvisor'] as const) {
      assert.equal((await generatedTun(platform, false, { stack }))?.stack, stack)
    }
    assert.equal((await generatedTun(platform, false, undefined))?.stack, 'mixed')
  })
}

test('new controlled TUN settings use gVisor only on macOS', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const template = loadMainModule(
      new URL('../src/main/utils/template.ts', import.meta.url),
      {},
      {
        process: { platform }
      }
    ) as unknown as { defaultControledMihomoConfig: Partial<MihomoConfig> }
    assert.equal(
      template.defaultControledMihomoConfig.tun?.stack,
      platform === 'darwin' ? 'gvisor' : 'mixed'
    )
  }
})
