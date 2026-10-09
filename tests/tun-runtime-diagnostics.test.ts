import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCoreDiagnostics, parseCoreStartupIssue } from '../src/main/core/core-diagnostics'
import { applyProxyControl, ProxyActivationError } from '../src/renderer/src/utils/proxy-control'

// Captured from the reported macOS TUN failure. No account or network data is needed.
const packetReadFailure = 'level=error msg="batch read packet: bad file descriptor"\n'

test('captured TUN packet-read failures are visible to the activation diagnostics', () => {
  const diagnostics = createCoreDiagnostics()
  const before = diagnostics.read()
  diagnostics.push(packetReadFailure.slice(0, 20))
  diagnostics.push(packetReadFailure.slice(20) + packetReadFailure)
  assert.deepEqual(diagnostics.read(before.cursor).issues, [{ reason: 'tun-read-failed' }])
  assert.equal(parseCoreStartupIssue('connection error: bad file descriptor'), undefined)
})

test('TUN configuration enabled cannot hide a captured packet-reader failure during activation', async () => {
  const diagnostics = createCoreDiagnostics()
  const systemProxyChanges: boolean[] = []
  const app = {
    mainSwitchMode: 'sysproxy',
    proxyMode: true,
    sysProxy: { enable: true, mode: 'manual' }
  } as AppConfig
  const core = { tun: { enable: false }, 'mixed-port': 7890 } as Partial<MihomoConfig>
  let runtimeTun = false

  await assert.rejects(
    applyProxyControl('tun', true, app, core, {
      patchApp: async () => {},
      patchCore: async (patch) => {
        runtimeTun = patch.tun?.enable ?? false
      },
      reload: async () => {
        if (runtimeTun) diagnostics.push(packetReadFailure)
      },
      // Mihomo's enabled configuration does not prove its packet reader is healthy.
      readRuntime: async () => ({ tun: { enable: runtimeTun } }) as ControllerConfigs,
      readDiagnostics: async (after) => diagnostics.read(after),
      setSystemProxy: async (enable) => {
        systemProxyChanges.push(enable)
      }
    }),
    ProxyActivationError
  )
  assert.equal(runtimeTun, false)
  assert.deepEqual(systemProxyChanges, [false, true])
})

test('switching back to system proxy is allowed despite a stale TUN packet-reader error', async () => {
  const diagnostics = createCoreDiagnostics()
  diagnostics.push(packetReadFailure)
  let systemProxyEnabled = false
  let runtimeTun = true
  await applyProxyControl(
    'sysproxy',
    true,
    { proxyMode: false, sysProxy: { enable: true, mode: 'manual' } } as AppConfig,
    { tun: { enable: true }, 'mixed-port': 7890 } as Partial<MihomoConfig>,
    {
      patchApp: async () => {},
      patchCore: async (patch) => {
        runtimeTun = patch.tun?.enable ?? false
      },
      // The failing old reader can still emit an error while TUN is being disabled.
      reload: async () => diagnostics.push(packetReadFailure),
      readRuntime: async () => ({ tun: { enable: runtimeTun } }) as ControllerConfigs,
      readDiagnostics: async (after) => diagnostics.read(after),
      setSystemProxy: async (enable) => {
        systemProxyEnabled = enable
      }
    }
  )
  assert.equal(runtimeTun, false)
  assert.equal(systemProxyEnabled, true)
})
