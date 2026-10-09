import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadMainModule } from './helpers/load-main-module'

function fixture(tun: Partial<MihomoTunConfig> | undefined, controlTun = false) {
  const patches: Array<Partial<ControllerConfigs>> = []
  const saved: unknown[] = []
  const module = loadMainModule(new URL('../src/main/config/controledMihomo.ts', import.meta.url), {
    '../utils/dirs': { controledMihomoConfigPath: () => '/fixture/mihomo.yaml' },
    'fs/promises': {
      readFile: async () => '',
      writeFile: async (_path: string, data: string) => saved.push(JSON.parse(data))
    },
    '../utils/yaml': {
      parseYaml: () => ({ tun: { enable: false } }),
      stringifyYaml: JSON.stringify
    },
    '../core/factory': {
      generateProfile: async () => ({ logLevel: 'info' }),
      getRuntimeConfig: async () => ({ tun })
    },
    './app': { getAppConfig: async () => ({ controlTun }) },
    '../utils/template': { defaultControledMihomoConfig: {} },
    '../utils/merge': {
      deepMerge: (target: object, patch: object) => Object.assign(target, patch)
    },
    '../core/manager': { setPublicDNS: async () => {}, recoverDNS: async () => {} },
    '../core/mihomoApi': {
      patchMihomoConfig: async (patch: Partial<ControllerConfigs>) => patches.push(patch),
      applyLogLevel: async () => {}
    }
  })
  return { module, patches, saved }
}

test('enabling TUN applies the generated stack immediately instead of briefly starting the old runtime stack', async () => {
  const f = fixture({ enable: true, stack: 'gvisor', 'auto-route': true, 'dns-hijack': ['any:53'] })
  await f.module.patchControledMihomoConfig({ tun: { enable: true } })
  assert.equal(f.patches.length, 1)
  assert.equal(f.patches[0].tun?.stack, 'gvisor')
  assert.equal(f.patches[0].tun?.enable, true)
  assert.deepEqual(f.patches[0].tun?.['dns-hijack'], ['any:53'])
})

test('disabled generated TUN still sends an explicit disable command', async () => {
  const f = fixture(undefined)
  await f.module.patchControledMihomoConfig({ tun: { enable: false } })
  assert.equal(f.patches[0].tun?.enable, false)
})

test('ordinary mode patches do not alter TUN or copy its generated settings', async () => {
  const f = fixture({ enable: true, stack: 'gvisor' })
  await f.module.patchControledMihomoConfig({ mode: 'rule' })
  assert.equal(f.patches[0].mode, 'rule')
  assert.equal(f.patches[0].tun, undefined)
})

test('manual TUN saves retain explicit default values and cleared lists for the patch API', async () => {
  // Full YAML omits defaults, but PATCH must send them to overwrite prior runtime values.
  const f = fixture({ enable: true, stack: 'system' }, true)
  await f.module.patchControledMihomoConfig({
    tun: {
      'auto-route': true,
      'auto-detect-interface': true,
      'strict-route': false,
      'route-exclude-address': []
    }
  })
  assert.equal(f.patches[0].tun?.['auto-route'], true)
  assert.equal(f.patches[0].tun?.['auto-detect-interface'], true)
  assert.equal(f.patches[0].tun?.['strict-route'], false)
  assert.deepEqual(f.patches[0].tun?.['route-exclude-address'], [])
})
