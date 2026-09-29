export type ProxyMode = 'sysproxy' | 'tun'

export interface ProxyControlDependencies {
  patchApp: (patch: Partial<AppConfig>) => Promise<void>
  patchCore: (patch: Partial<MihomoConfig>) => Promise<void>
  reload: () => Promise<void>
  setSystemProxy: (enable: boolean, onlyActiveDevice: boolean) => Promise<void>
  readRuntime: () => Promise<ControllerConfigs>
  ensureTunPermission?: () => Promise<void>
  readDiagnostics?: (after?: number) => Promise<CoreDiagnosticsSnapshot>
  wait?: (milliseconds: number) => Promise<void>
}

export class ProxyActivationError extends Error {
  constructor(public readonly issues: CoreStartupIssue[]) {
    super('The core could not start the requested proxy listeners')
    this.name = 'ProxyActivationError'
  }
}

export class TunPermissionRequiredError extends Error {
  constructor() {
    super('TUN requires core authorization')
    this.name = 'TunPermissionRequiredError'
  }
}

export class ProxyModeNotAppliedError extends Error {
  constructor(
    public readonly mode: ProxyMode,
    public readonly enabled: boolean
  ) {
    super('Proxy mode was not applied by the core')
    this.name = 'ProxyModeNotAppliedError'
  }
}

// Keep the mode preference separate from activation. Raw IPC calls must reject on
// failure; the legacy config hooks deliberately consume errors for settings forms.
export async function applyProxyControl(
  mode: ProxyMode,
  enabled: boolean | undefined,
  app: AppConfig,
  core: Partial<MihomoConfig>,
  deps: ProxyControlDependencies
): Promise<void> {
  if (enabled === undefined) {
    await deps.patchApp({ mainSwitchMode: mode })
    return
  }

  const writeSystemProxy = app.sysProxy?.enable !== false
  const onlyActiveDevice = app.onlyActiveDevice ?? false
  const tun = enabled && mode === 'tun'
  const proxy = enabled && mode === 'sysproxy'
  if (tun) await deps.ensureTunPermission?.()
  if (proxy && writeSystemProxy && app.sysProxy?.mode === 'manual' && core['mixed-port'] === 0) {
    throw new Error('The mixed port is disabled')
  }
  const enableDns = tun && app.controlDns && core.dns?.enable === false
  // Only consider messages produced by this attempt; old failures must not taint a retry.
  const diagnostics = await deps.readDiagnostics?.().catch(() => undefined)
  const readStartupIssues = async (): Promise<CoreStartupIssue[]> => {
    if (!enabled || !diagnostics) return []
    const next = await deps.readDiagnostics?.(diagnostics.cursor).catch(() => undefined)
    return next?.issues.filter((issue) => tun || issue.reason === 'port-in-use') ?? []
  }
  let systemProxyTouched = false
  try {
    if (writeSystemProxy && app.proxyMode && !proxy) {
      systemProxyTouched = true
      await deps.setSystemProxy(false, onlyActiveDevice)
    }
    await deps.patchCore({ tun: { enable: tun }, ...(enableDns ? { dns: { enable: true } } : {}) })
    await deps.patchApp({ proxyMode: proxy })
    await deps.reload()
    const wait =
      deps.wait ??
      ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
    let applied = false
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await wait(250)
      const runtime = await deps.readRuntime()
      if (runtime.tun?.enable === tun) {
        applied = true
        break
      }
    }
    const issues = await readStartupIssues()
    if (issues.length) throw new ProxyActivationError(issues)
    if (!applied) throw new ProxyModeNotAppliedError(mode, enabled)
    if (writeSystemProxy && proxy) {
      systemProxyTouched = true
      await deps.setSystemProxy(true, onlyActiveDevice)
    }
    await deps.patchApp({ mainSwitchMode: mode })
  } catch (error) {
    // Snapshot the startup failure before rollback changes the core's log stream.
    const issues = error instanceof ProxyActivationError ? error.issues : await readStartupIssues()
    const failure = issues.length ? new ProxyActivationError(issues) : error
    // Attempt every recovery step, even when one fails. Never hide a partial recovery.
    const failures: unknown[] = []
    const recover = async (action: () => Promise<void>): Promise<void> => {
      try {
        await action()
      } catch (failure) {
        failures.push(failure)
      }
    }
    await recover(() =>
      deps.patchCore({
        tun: { enable: core.tun?.enable ?? false },
        ...(enableDns ? { dns: { enable: false } } : {})
      })
    )
    await recover(() =>
      deps.patchApp({
        proxyMode: app.proxyMode ?? false,
        mainSwitchMode: app.mainSwitchMode ?? 'tun'
      })
    )
    await recover(deps.reload)
    if (systemProxyTouched) {
      await recover(() => deps.setSystemProxy(app.proxyMode ?? false, onlyActiveDevice))
    }
    if (failures.length)
      throw new AggregateError([failure, ...failures], 'Proxy mode recovery failed')
    throw failure
  }
}
