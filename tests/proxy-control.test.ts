import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyProxyControl,
  TunPermissionRequiredError,
  ProxyModeNotAppliedError,
  type ProxyControlDependencies
} from '../src/renderer/src/utils/proxy-control'

test('missing TUN permission rejects before disabling an existing system proxy', async () => {
  const f = fixture()
  f.app.proxyMode = true
  f.core.tun!.enable = false
  f.deps.ensureTunPermission = async () => {
    throw new TunPermissionRequiredError()
  }
  await assert.rejects(
    applyProxyControl('tun', true, f.app, f.core, f.deps),
    TunPermissionRequiredError
  )
  assert.deepEqual(f.calls, [])
})

test('a TUN route conflict reports the current core error and restores the previous proxy', async () => {
  const f = fixture()
  f.app.mainSwitchMode = 'sysproxy'
  f.app.proxyMode = true
  f.core.tun!.enable = false
  f.deps.readRuntime = async () => ({ tun: { enable: false } }) as ControllerConfigs
  f.deps.wait = async () => {}
  let reads = 0
  f.deps.readDiagnostics = async (after) => {
    if (++reads === 1) return { cursor: 7, issues: [] }
    assert.equal(after, 7)
    return {
      cursor: 9,
      issues: [{ reason: 'tun-route-conflict' }, { reason: 'port-in-use', port: 7897 }]
    }
  }
  await assert.rejects(applyProxyControl('tun', true, f.app, f.core, f.deps), (error: Error) => {
    assert.equal(error.name, 'ProxyActivationError')
    assert.deepEqual((error as Error & { issues: unknown[] }).issues, [
      { reason: 'tun-route-conflict' },
      { reason: 'port-in-use', port: 7897 }
    ])
    return true
  })
  assert.equal(f.calls.at(-1), 'system:true')
})

function fixture(failSystem = false, failRecovery = false) {
  const calls: string[] = []
  const app = {
    mainSwitchMode: 'tun',
    proxyMode: false,
    sysProxy: { enable: true, mode: 'manual' }
  } as AppConfig
  const core = { tun: { enable: true }, 'mixed-port': 7890 } as Partial<MihomoConfig>
  let runtimeTun = true
  let systemCalls = 0
  const deps: ProxyControlDependencies = {
    patchApp: async (patch) => {
      calls.push(`app:${JSON.stringify(patch)}`)
    },
    patchCore: async (patch) => {
      calls.push(`tun:${patch.tun?.enable}`)
      runtimeTun = patch.tun?.enable ?? false
    },
    reload: async () => {
      calls.push('reload')
      if (failRecovery && calls.filter((c) => c === 'reload').length > 1) throw Error('recovery')
    },
    readRuntime: async () => ({ tun: { enable: runtimeTun } }) as ControllerConfigs,
    setSystemProxy: async (enable) => {
      calls.push(`system:${enable}`)
      if (failSystem && ++systemCalls === 1) throw Error('system proxy')
    }
  }
  return { app, core, deps, calls }
}

test('choosing an idle mode only changes the preference', async () => {
  const f = fixture()
  await applyProxyControl('sysproxy', undefined, f.app, f.core, f.deps)
  assert.deepEqual(f.calls, ['app:{"mainSwitchMode":"sysproxy"}'])
})
test('switching to default disables TUN and reloads before enabling the system proxy', async () => {
  const f = fixture()
  await applyProxyControl('sysproxy', true, f.app, f.core, f.deps)
  assert.deepEqual(f.calls, [
    'tun:false',
    'app:{"proxyMode":true}',
    'reload',
    'system:true',
    'app:{"mainSwitchMode":"sysproxy"}'
  ])
})
test('a disabled mixed port rejects before making changes', async () => {
  const f = fixture()
  f.core['mixed-port'] = 0
  await assert.rejects(applyProxyControl('sysproxy', true, f.app, f.core, f.deps))
  assert.deepEqual(f.calls, [])
})
test('system proxy failure restores the previous mode and remains a failure', async () => {
  const f = fixture(true)
  await assert.rejects(applyProxyControl('sysproxy', true, f.app, f.core, f.deps), /system proxy/)
  assert.deepEqual(f.calls.slice(-4), [
    'tun:true',
    'app:{"proxyMode":false,"mainSwitchMode":"tun"}',
    'reload',
    'system:false'
  ])
})
test('incomplete recovery is reported separately and still attempts system restoration', async () => {
  const f = fixture(true, true)
  await assert.rejects(applyProxyControl('sysproxy', true, f.app, f.core, f.deps), AggregateError)
  assert.equal(f.calls.at(-1), 'system:false')
})
test('the no-system-proxy preference is respected', async () => {
  const f = fixture()
  f.app.sysProxy!.enable = false
  await applyProxyControl('sysproxy', true, f.app, f.core, f.deps)
  assert.equal(
    f.calls.some((c) => c.startsWith('system:')),
    false
  )
})
test('disabling proxy also works when the mixed port has been disabled', async () => {
  const f = fixture()
  f.app.proxyMode = true
  f.core['mixed-port'] = 0
  await applyProxyControl('sysproxy', false, f.app, f.core, f.deps)
  assert.equal(f.calls[0], 'system:false')
  assert.ok(f.calls.includes('tun:false'))
})

test('a delayed TUN activation is allowed to settle after reloading', async () => {
  const f = fixture()
  f.app.mainSwitchMode = 'sysproxy'
  f.app.proxyMode = true
  f.core.tun!.enable = false
  let reads = 0
  f.deps.readRuntime = async () => ({ tun: { enable: ++reads > 1 } }) as ControllerConfigs
  f.deps.wait = async () => {}

  await applyProxyControl('tun', true, f.app, f.core, f.deps)
  assert.equal(reads, 2)
  assert.ok(f.calls.includes('app:{"mainSwitchMode":"tun"}'))
})

test('a rejected TUN activation rolls back after the settling window', async () => {
  const f = fixture()
  f.app.mainSwitchMode = 'sysproxy'
  f.app.proxyMode = true
  f.core.tun!.enable = false
  let reads = 0
  f.deps.readRuntime = async () => {
    reads++
    return { tun: { enable: false } } as ControllerConfigs
  }
  f.deps.wait = async () => {}

  await assert.rejects(
    applyProxyControl('tun', true, f.app, f.core, f.deps),
    ProxyModeNotAppliedError
  )
  assert.equal(reads, 5)
  assert.deepEqual(f.calls.slice(-4), [
    'tun:false',
    'app:{"proxyMode":true,"mainSwitchMode":"sysproxy"}',
    'reload',
    'system:true'
  ])
})
