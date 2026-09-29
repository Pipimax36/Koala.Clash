import { useEffect } from 'react'
import { create } from 'zustand'
import useSWR, { mutate } from 'swr'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useAppConfig } from './use-app-config'
import { useControledMihomoConfig } from './use-controled-mihomo-config'
import * as ipc from '@renderer/utils/ipc'
import {
  applyProxyControl,
  ProxyModeNotAppliedError,
  ProxyActivationError,
  TunPermissionRequiredError,
  type ProxyMode
} from '@renderer/utils/proxy-control'
import { subscribeCoreStarted } from '@renderer/store/core-lifecycle-store'
import { platform } from '@renderer/utils/init'

const useOperation = create<{ busy: boolean; error: string | null }>(() => ({
  busy: false,
  error: null
}))

export function useProxyControl() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { appConfig } = useAppConfig()
  const { controledMihomoConfig } = useControledMihomoConfig()
  const { busy, error } = useOperation()
  const {
    data: runtime,
    error: runtimeError,
    mutate: refresh
  } = useSWR('mihomoConfig', ipc.mihomoConfig, {
    refreshInterval: 5000,
    errorRetryInterval: 5000
  })
  useEffect(
    () =>
      subscribeCoreStarted(() => {
        void refresh()
      }),
    [refresh]
  )
  const enabled = Boolean(
    (runtimeError ? controledMihomoConfig?.tun?.enable : runtime?.tun?.enable) ||
    appConfig?.proxyMode
  )
  const mode = appConfig?.mainSwitchMode ?? 'tun'
  const ready = Boolean(appConfig && controledMihomoConfig)
  const portDisabled =
    mode === 'sysproxy' &&
    appConfig?.sysProxy?.enable !== false &&
    appConfig?.sysProxy?.mode === 'manual' &&
    controledMihomoConfig?.['mixed-port'] === 0

  async function apply(nextMode: ProxyMode, activate?: boolean): Promise<void> {
    if (useOperation.getState().busy) return
    useOperation.setState({ busy: true, error: null })
    try {
      const [app, core] = await Promise.all([ipc.getAppConfig(), ipc.getControledMihomoConfig()])
      await applyProxyControl(nextMode, activate, app, core, {
        patchApp: ipc.patchAppConfig,
        patchCore: ipc.patchControledMihomoConfig,
        reload: ipc.mihomoHotReloadConfig,
        setSystemProxy: ipc.triggerSysProxy,
        readRuntime: ipc.mihomoConfig,
        readDiagnostics: ipc.getCoreDiagnostics,
        ensureTunPermission: async () => {
          if (platform !== 'darwin' && platform !== 'linux') return
          if (app.core === 'system') return
          const permissions = await ipc.checkCorePermission()
          if (!permissions[app.core ?? 'mihomo']) throw new TunPermissionRequiredError()
        }
      })
    } catch (cause) {
      const activationError =
        cause instanceof ProxyActivationError
          ? cause
          : cause instanceof AggregateError
            ? (cause.errors.find((error) => error instanceof ProxyActivationError) as
                | ProxyActivationError
                | undefined)
            : undefined
      const startupMessage = activationError?.issues
        .map((issue) => {
          switch (issue.reason) {
            case 'tun-route-conflict':
              return t('redesign.tunRouteConflict')
            case 'tun-permission-denied':
              return t('redesign.tunPermissionDenied')
            case 'port-in-use':
              return t(issue.port ? 'redesign.proxyPortInUse' : 'redesign.proxyPortConflict', {
                port: issue.port
              })
            default:
              return t('redesign.tunStartupFailed')
          }
        })
        .join(' ')
      const message = startupMessage
        ? `${startupMessage} ${t(cause instanceof AggregateError ? 'redesign.recoveryFailed' : 'redesign.proxySettingsRestored')}`
        : cause instanceof TunPermissionRequiredError
          ? t('redesign.tunPermissionRequired')
          : cause instanceof ProxyModeNotAppliedError
            ? t(
                cause.enabled && cause.mode === 'tun'
                  ? 'redesign.tunNotApplied'
                  : 'redesign.modeNotApplied'
              )
            : `${t(cause instanceof AggregateError ? 'redesign.recoveryFailed' : 'redesign.operationFailed')}: ${String(cause)}`
      useOperation.setState({ error: message })
      toast.error(
        message,
        cause instanceof TunPermissionRequiredError
          ? {
              action: {
                label: t('redesign.authorizeCore'),
                onClick: () => navigate('/mihomo', { state: { authorizeCore: true } })
              }
            }
          : activationError
            ? { action: { label: t('redesign.viewLogs'), onClick: () => navigate('/logs') } }
            : undefined
      )
    } finally {
      await Promise.allSettled([
        mutate('getConfig'),
        mutate('getControledMihomoConfig'),
        refresh(),
        ipc.updateTrayIcon()
      ])
      window.electron.ipcRenderer.send('updateTrayMenu')
      window.electron.ipcRenderer.send('updateFloatingWindow')
      useOperation.setState({ busy: false })
    }
  }
  const clearError = (): void => useOperation.setState({ error: null })
  return {
    mode,
    enabled,
    busy,
    error,
    ready,
    portDisabled,
    runtimeError,
    runtime,
    apply,
    refresh,
    clearError
  }
}
