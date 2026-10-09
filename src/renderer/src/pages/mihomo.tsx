import { toast } from 'sonner'
import useSWR from 'swr'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import BasePage from '@renderer/components/base/base-page'
import SettingCard from '@renderer/components/base/base-setting-card'
import SettingItem from '@renderer/components/base/base-setting-item'
import ConfirmModal, { ConfirmButton } from '@renderer/components/base/base-confirm'
import PermissionModal from '@renderer/components/mihomo/permission-modal'
import ServiceModal from '@renderer/components/mihomo/service-modal'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import PortSetting from '@renderer/components/mihomo/port-setting'
import { platform } from '@renderer/utils/init'
import PubSub from 'pubsub-js'
import {
  manualGrantCorePermition,
  mihomoUpgrade,
  restartCore,
  revokeCorePermission,
  findSystemMihomo,
  getSystemCorePath,
  patchAppConfig as saveAppConfig,
  deleteElevateTask,
  checkElevateTask,
  relaunchApp,
  restartAsAdmin,
  notDialogQuit,
  installService,
  uninstallService,
  startService,
  stopService,
  initService,
  restartService,
  mihomoVersion,
  mihomoHotReloadConfig,
  checkCorePermission,
  serviceStatus
} from '@renderer/utils/ipc'
import React, { useState, useEffect } from 'react'
import ControllerSetting from '@renderer/components/mihomo/controller-setting'
import EnvSetting from '@renderer/components/mihomo/env-setting'
import AdvancedSetting from '@renderer/components/mihomo/advanced-settings'
import { useTranslation } from 'react-i18next'
import { ChevronRight, CloudDownload, Cpu, RotateCw } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useProxyControl } from '@renderer/hooks/use-proxy-control'
import { useConnectionsStore } from '@renderer/store/connections-store'
import { useCoreLifecycleStore } from '@renderer/store/core-lifecycle-store'
import '@renderer/components/mihomo/mihomo-layout.css'

let systemCorePathsCache: string[] | null = null
let cachePromise: Promise<string[]> | null = null

const getSystemCorePaths = async (): Promise<string[]> => {
  if (systemCorePathsCache !== null) return systemCorePathsCache
  if (cachePromise !== null) return cachePromise

  cachePromise = findSystemMihomo()
    .then((paths) => {
      systemCorePathsCache = paths
      cachePromise = null
      return paths
    })
    .catch(() => {
      cachePromise = null
      return []
    })

  return cachePromise
}

getSystemCorePaths().catch(() => {})

function CoreRow({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ks-core-row">
      <div className="ks-core-row-copy">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {children}
    </div>
  )
}

const Mihomo: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const control = useProxyControl()
  const [restarting, setRestarting] = useState(false)
  const { appConfig, patchAppConfig, mutateAppConfig } = useAppConfig()
  const { core = 'mihomo', maxLogDays = 7, corePermissionMode = 'elevated' } = appConfig || {}
  const { data: systemCorePath, mutate: refreshSystemCorePath } = useSWR(
    core === 'system' ? 'systemCorePath' : null,
    getSystemCorePath,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  )
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const {
    ipv6,
    'allow-lan': allowLan,
    'mixed-port': mixedPort,
    'external-controller': externalController = '',
    'log-level': logLevel = 'info'
  } = controledMihomoConfig || {}
  const { data: coreVersion } = useSWR('mihomoVersion', mihomoVersion)
  const { data: permissionStatus, mutate: refreshPermissionStatus } = useSWR(
    'corePermissionStatus',
    async () => (platform === 'win32' ? checkElevateTask() : checkCorePermission())
  )
  const { data: installedServiceStatus, mutate: refreshServiceStatus } = useSWR(
    'serviceStatus',
    serviceStatus
  )
  const memoryBytes = useConnectionsStore((state) => state.info.memory)
  const coreStartedAt = useCoreLifecycleStore((state) => state.startedAt)
  const [clock, setClock] = useState(Date.now())

  const [upgrading, setUpgrading] = useState(false)
  const [showGrantConfirm, setShowGrantConfirm] = useState(false)
  const [showUnGrantConfirm, setShowUnGrantConfirm] = useState(false)
  const [showPermissionModal, setShowPermissionModal] = useState(false)
  const [showServiceModal, setShowServiceModal] = useState(false)
  const [pendingPermissionMode, setPendingPermissionMode] = useState<string>('')
  const [systemCorePaths, setSystemCorePaths] = useState<string[]>(systemCorePathsCache || [])
  const [loadingPaths, setLoadingPaths] = useState(systemCorePathsCache === null)

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  const coreRunning = Boolean(control.runtime && !control.runtimeError)
  const hasPermission =
    core === 'system'
      ? null
      : corePermissionMode === 'service'
        ? installedServiceStatus === 'running'
        : typeof permissionStatus === 'boolean'
          ? permissionStatus
          : permissionStatus?.[core]
  const externalPort = externalController.match(/:(\d+)$/)?.[1] || '—'
  const uptimeMinutes =
    coreRunning && coreStartedAt > 0
      ? Math.max(0, Math.floor((clock - coreStartedAt) / 60000))
      : null

  useEffect(() => {
    if (location.state?.authorizeCore) {
      setShowPermissionModal(true)
      navigate(location.pathname, { replace: true, state: null })
    }
  }, [location, navigate])

  useEffect(() => {
    if (systemCorePathsCache !== null) return

    getSystemCorePaths()
      .then(setSystemCorePaths)
      .catch(() => {})
      .finally(() => setLoadingPaths(false))
  }, [])

  const onChangeNeedRestart = async (patch: Partial<MihomoConfig>): Promise<void> => {
    try {
      await patchControledMihomoConfig(patch)
      await mihomoHotReloadConfig()
    } catch (error) {
      toast.error(String(error))
    }
  }

  const handleConfigChangeWithRestart = async (key: string, value: unknown): Promise<void> => {
    try {
      await saveAppConfig({ [key]: value })
      mutateAppConfig()
      if (key === 'systemCorePath') await refreshSystemCorePath(String(value), false)
      await restartCore()
      PubSub.publish('mihomo-core-changed')
    } catch (e) {
      toast.error(`${e}`)
    }
  }

  const handleCoreUpgrade = async (): Promise<void> => {
    try {
      setUpgrading(true)
      await mihomoUpgrade()
      setTimeout(() => PubSub.publish('mihomo-core-changed'), 2000)
      toast.success(t('pages.mihomo.updateComplete'))
    } catch (e) {
      if (typeof e === 'string' && e.includes('already using latest version')) {
        new Notification(t('pages.mihomo.alreadyLatest'))
      } else {
        toast.error(`${e}`)
      }
    } finally {
      setUpgrading(false)
    }
  }

  const handleCoreChange = async (newCore: 'mihomo' | 'mihomo-alpha' | 'system'): Promise<void> => {
    try {
      if (newCore === 'system') {
        const paths = await getSystemCorePaths()

        if (paths.length === 0) {
          new Notification(t('pages.mihomo.systemCoreNotFound'), {
            body: t('pages.mihomo.systemCoreNotFoundBody')
          })
          return
        }

        const savedPath = await getSystemCorePath()
        if (!savedPath || !paths.includes(savedPath)) {
          await saveAppConfig({ systemCorePath: paths[0] })
          mutateAppConfig()
        }
      }
      await handleConfigChangeWithRestart('core', newCore)
    } catch (error) {
      toast.error(String(error))
    }
  }

  const handlePermissionModeChange = async (key: string): Promise<void> => {
    if (platform === 'win32') {
      if (key !== 'elevated') {
        if (await checkElevateTask()) {
          setPendingPermissionMode(key)
          setShowUnGrantConfirm(true)
        } else {
          patchAppConfig({ corePermissionMode: key as 'elevated' | 'service' })
        }
      } else if (key === 'elevated') {
        setPendingPermissionMode(key)
        setShowGrantConfirm(true)
      }
    } else {
      patchAppConfig({ corePermissionMode: key as 'elevated' | 'service' })
    }
  }

  const extraUnGrantButtons: ConfirmButton[] =
    platform === 'win32'
      ? [
          {
            key: 'cancel-and-restart',
            text: t('pages.mihomo.cancelAndRestart'),
            variant: 'destructive',
            onPress: async () => {
              try {
                await deleteElevateTask()
                new Notification(t('pages.mihomo.taskScheduleCanceled'))
                await patchAppConfig({
                  corePermissionMode: pendingPermissionMode as 'elevated' | 'service'
                })
                await relaunchApp()
              } catch (e) {
                toast.error(`${e}`)
              }
            }
          }
        ]
      : []

  const unGrantButtons: ConfirmButton[] = [
    {
      key: 'cancel',
      text: t('common.cancel'),
      variant: 'ghost',
      onPress: () => {}
    },
    {
      key: 'confirm',
      text:
        platform === 'win32' ? t('pages.mihomo.noRestartCancel') : t('pages.mihomo.confirmRevoke'),
      variant: 'destructive',
      onPress: async () => {
        try {
          if (platform === 'win32') {
            await deleteElevateTask()
            new Notification(t('pages.mihomo.taskScheduleCanceled'))
          } else {
            await revokeCorePermission()
            new Notification(t('pages.mihomo.corePermissionRevoked'))
          }
          await patchAppConfig({
            corePermissionMode: pendingPermissionMode as 'elevated' | 'service'
          })

          await restartCore()
        } catch (e) {
          toast.error(`${e}`)
        }
      }
    },
    ...extraUnGrantButtons
  ]

  const logLevelOptions: { value: LogLevel; label: string }[] = [
    { value: 'silent', label: t('pages.mihomo.silent') },
    { value: 'error', label: t('pages.mihomo.error') },
    { value: 'warning', label: t('pages.mihomo.warning') },
    { value: 'info', label: t('pages.mihomo.info') },
    { value: 'debug', label: t('pages.mihomo.debug') }
  ]

  return (
    <BasePage
      title={t('redesign.coreTitle', { defaultValue: '内核' })}
      subtitle={t('redesign.coreSubtitle')}
      contentClassName="ks-mihomo-content"
      header={
        <Button variant="outline" onClick={() => navigate('/logs')}>
          {t('redesign.viewLogs')}
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      }
    >
      {showGrantConfirm && (
        <ConfirmModal
          onChange={setShowGrantConfirm}
          title={t('pages.mihomo.confirmUseTaskSchedule')}
          description={t('pages.mihomo.confirmUseTaskScheduleDesc')}
          onConfirm={async () => {
            await patchAppConfig({
              corePermissionMode: pendingPermissionMode as 'elevated' | 'service',
              // Asking for the task schedule again overrides an earlier refusal to elevate
              elevationDeclined: false
            })
            await notDialogQuit()
          }}
        />
      )}
      {showUnGrantConfirm && (
        <ConfirmModal
          onChange={setShowUnGrantConfirm}
          title={t('pages.mihomo.confirmCancelTaskSchedule')}
          description={t('pages.mihomo.confirmCancelTaskScheduleDesc')}
          buttons={unGrantButtons}
        />
      )}
      {showPermissionModal && (
        <PermissionModal
          onChange={(open) => {
            setShowPermissionModal(open)
            if (!open) void refreshPermissionStatus()
          }}
          onRevoke={async () => {
            if (platform === 'win32') {
              await deleteElevateTask()
              new Notification(t('pages.mihomo.taskScheduleCanceled'))
            } else {
              await revokeCorePermission()
              new Notification(t('pages.mihomo.corePermissionRevoked'))
            }
            await restartCore()
          }}
          onGrant={async () => {
            if (platform === 'win32') {
              await restartAsAdmin()
              return
            }
            await manualGrantCorePermition()
            new Notification(t('pages.mihomo.coreAuthSuccess'))
            await restartCore()
          }}
        />
      )}
      {showServiceModal && (
        <ServiceModal
          onChange={(open) => {
            setShowServiceModal(open)
            if (!open) void refreshServiceStatus()
          }}
          onInit={async () => {
            await initService()
            new Notification(t('pages.mihomo.serviceInitSuccess'))
          }}
          onInstall={async () => {
            await installService()
            new Notification(t('pages.mihomo.serviceInstallSuccess'))
          }}
          onUninstall={async () => {
            await uninstallService()
            new Notification(t('pages.mihomo.serviceUninstallSuccess'))
          }}
          onStart={async () => {
            await startService()
            new Notification(t('pages.mihomo.serviceStartSuccess'))
          }}
          onRestart={async () => {
            await restartService()
            new Notification(t('pages.mihomo.serviceRestartSuccess'))
          }}
          onStop={async () => {
            await stopService()
            new Notification(t('pages.mihomo.serviceStopSuccess'))
          }}
        />
      )}
      <div className="ks-core-stack">
        <section className="ks-core-status">
          <div className="ks-core-symbol">
            <Cpu aria-hidden="true" />
          </div>
          <div className="ks-core-status-copy">
            <h2>Mihomo</h2>
            <p>
              {coreVersion?.version || '—'} ·{' '}
              {t(
                core === 'mihomo-alpha'
                  ? 'pages.mihomo.builtinPreview'
                  : core === 'system'
                    ? 'pages.mihomo.useSystemCore'
                    : 'pages.mihomo.builtinStable'
              )}
            </p>
          </div>
          <span className="ks-core-state" data-running={coreRunning}>
            <span className="ks-core-state-dot" />
            {t(
              control.runtimeError
                ? 'redesign.coreStopped'
                : coreRunning
                  ? 'redesign.coreRunningShort'
                  : 'redesign.loading',
              {
                defaultValue: control.runtimeError ? '已停止' : coreRunning ? '运行中' : '正在检测'
              }
            )}
          </span>
          <Button
            variant="outline"
            className="ks-core-restart"
            disabled={restarting}
            onClick={async () => {
              setRestarting(true)
              try {
                await restartCore()
                await control.refresh()
                void refreshPermissionStatus()
              } catch (error) {
                toast.error(String(error))
              } finally {
                setRestarting(false)
              }
            }}
          >
            {restarting ? <Spinner className="size-4" /> : <RotateCw className="size-4" />}
            {t(coreRunning ? 'redesign.restartCoreButton' : 'redesign.startCoreButton', {
              defaultValue: coreRunning ? '重新启动' : '启动内核'
            })}
          </Button>
        </section>
        <div className="ks-core-grid">
          <section className="ks-core-panel">
            <h2>{t('redesign.coreConnectionPorts', { defaultValue: '连接与端口' })}</h2>
            <CoreRow
              title={t('redesign.mixedProxyPort', { defaultValue: '混合代理端口' })}
              description="HTTP / SOCKS"
            >
              <span className="ks-core-mono">{mixedPort ?? '—'}</span>
            </CoreRow>
            <CoreRow
              title={t('redesign.externalControlPort', { defaultValue: '外部控制端口' })}
              description={t('redesign.externalControlDescription', {
                defaultValue: '应用与内核通信'
              })}
            >
              <span className="ks-core-mono">{externalPort}</span>
            </CoreRow>
            <CoreRow
              title={t('redesign.lanConnection', { defaultValue: '局域网连接' })}
              description={t('redesign.allowLanDescription')}
            >
              <Switch
                className="ks-core-toggle"
                aria-label={t('mihomo.portSettings.allowLan')}
                checked={Boolean(allowLan)}
                onCheckedChange={(checked) => void onChangeNeedRestart({ 'allow-lan': checked })}
              />
            </CoreRow>
            <CoreRow
              title="IPv6"
              description={t('redesign.ipv6Description', {
                defaultValue: '启用 IPv6 解析与连接'
              })}
            >
              <Switch
                className="ks-core-toggle"
                aria-label="IPv6"
                checked={Boolean(ipv6)}
                onCheckedChange={(checked) => void onChangeNeedRestart({ ipv6: checked })}
              />
            </CoreRow>
          </section>
          <section className="ks-core-panel">
            <div className="ks-core-service-heading">
              <h2>{t('redesign.systemServices', { defaultValue: '系统服务' })}</h2>
              <span className="ks-core-service-pill" data-authorized={hasPermission === true}>
                {core === 'system'
                  ? t('pages.mihomo.useSystemCore')
                  : hasPermission === undefined
                    ? t('redesign.loading')
                    : hasPermission
                      ? t('mihomo.permissionModal.authorized')
                      : t('mihomo.permissionModal.unauthorized')}
              </span>
            </div>
            <p className="ks-core-service-description">
              {core === 'system'
                ? t('pages.mihomo.useSystemCore')
                : hasPermission
                  ? t('redesign.serviceReady', {
                      defaultValue: '服务已就绪，可使用 TUN 虚拟网卡模式。'
                    })
                  : t('redesign.servicePermissionHint', {
                      defaultValue: '授权内核后可使用 TUN 虚拟网卡模式。'
                    })}
            </p>
            <div className="ks-core-summary-line">
              <span>{t('redesign.memoryUsage', { defaultValue: '内存占用' })}</span>
              <span className="ks-core-mono">
                {coreRunning && memoryBytes > 0 ? (memoryBytes / 1048576).toFixed(1) + ' MB' : '—'}
              </span>
            </div>
            <div className="ks-core-summary-line">
              <span>{t('redesign.uptime', { defaultValue: '运行时长' })}</span>
              <span>
                {uptimeMinutes === null
                  ? '—'
                  : t('redesign.uptimeMinutes', {
                      count: uptimeMinutes,
                      defaultValue: '{{count}} 分钟'
                    })}
              </span>
            </div>
            <button type="button" className="ks-core-quick-link" onClick={() => navigate('/logs')}>
              {t('redesign.diagnosticLogs', { defaultValue: '诊断日志' })}
              <ChevronRight aria-hidden="true" />
            </button>
          </section>
        </div>
        <details className="ks-core-more">
          <summary>
            <ChevronRight aria-hidden="true" />
            {t('settings.advanced.moreSettings')}
          </summary>
          <div className="ks-core-advanced">
            <SettingCard title={t('redesign.coreConfiguration')}>
              <SettingItem
                title={t('redesign.updateChannel')}
                description={t('redesign.channelDescription')}
                actions={
                  core === 'mihomo' || core === 'mihomo-alpha' ? (
                    <Button
                      size="icon-sm"
                      title={t('pages.mihomo.upgradeCore')}
                      aria-label={t('pages.mihomo.upgradeCore')}
                      variant="ghost"
                      disabled={upgrading}
                      aria-busy={upgrading}
                      onClick={handleCoreUpgrade}
                    >
                      {upgrading ? (
                        <Spinner className="size-4" />
                      ) : (
                        <CloudDownload className="text-lg" />
                      )}
                    </Button>
                  ) : null
                }
              >
                <Select
                  value={core}
                  disabled={upgrading}
                  onValueChange={(value) =>
                    handleCoreChange(value as 'mihomo' | 'mihomo-alpha' | 'system')
                  }
                >
                  <SelectTrigger size="sm" className="ks-core-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mihomo">{t('pages.mihomo.builtinStable')}</SelectItem>
                    <SelectItem value="mihomo-alpha">{t('pages.mihomo.builtinPreview')}</SelectItem>
                    <SelectItem value="system">{t('pages.mihomo.useSystemCore')}</SelectItem>
                  </SelectContent>
                </Select>
              </SettingItem>
              {core === 'system' && (
                <SettingItem title={t('pages.mihomo.systemCorePath')}>
                  <Select
                    value={systemCorePath}
                    disabled={loadingPaths}
                    onValueChange={(value) => {
                      if (value) handleConfigChangeWithRestart('systemCorePath', value)
                    }}
                  >
                    <SelectTrigger size="sm" className="ks-core-select ks-core-path-select">
                      <SelectValue
                        placeholder={
                          loadingPaths
                            ? t('pages.mihomo.searchingCore')
                            : t('pages.mihomo.coreNotFound')
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {loadingPaths ? (
                        <SelectItem value="__searching__" disabled>
                          {t('pages.mihomo.searchingCore')}
                        </SelectItem>
                      ) : systemCorePaths.length > 0 ? (
                        systemCorePaths.map((path) => (
                          <SelectItem key={path} value={path}>
                            {path}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="__not_found__" disabled>
                          {t('pages.mihomo.coreNotFound')}
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {!loadingPaths && systemCorePaths.length === 0 && (
                    <div className="mt-2 text-sm text-warning">
                      {t('pages.mihomo.coreNotFoundWarning')}
                    </div>
                  )}
                </SettingItem>
              )}
              <SettingItem title={t('pages.mihomo.runningMode')}>
                <Tabs value={corePermissionMode} onValueChange={handlePermissionModeChange}>
                  <TabsList>
                    <TabsTrigger value="elevated">
                      {platform === 'win32'
                        ? t('pages.mihomo.taskSchedule')
                        : t('pages.mihomo.authorizedRun')}
                    </TabsTrigger>
                    <TabsTrigger value="service" disabled>
                      {t('pages.mihomo.systemService')}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </SettingItem>
              <SettingItem title={t('pages.mihomo.logRetentionDays')}>
                <Input
                  type="number"
                  className="h-8 w-[100px]"
                  value={maxLogDays.toString()}
                  onChange={(event) => patchAppConfig({ maxLogDays: parseInt(event.target.value) })}
                />
              </SettingItem>
              <SettingItem title={t('pages.mihomo.logLevel')}>
                <Select
                  value={logLevel}
                  onValueChange={(value) => onChangeNeedRestart({ 'log-level': value as LogLevel })}
                >
                  <SelectTrigger size="sm" className="ks-core-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {logLevelOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingItem>
            </SettingCard>
            <SettingCard title={t('redesign.coreDiagnostics')}>
              <SettingItem
                title={
                  platform === 'win32' ? t('pages.mihomo.taskStatus') : t('pages.mihomo.authStatus')
                }
              >
                <Button variant="outline" onClick={() => setShowPermissionModal(true)}>
                  {t('pages.mihomo.manage')}
                </Button>
              </SettingItem>
              <SettingItem title={t('pages.mihomo.serviceStatus')}>
                <Button variant="outline" onClick={() => setShowServiceModal(true)}>
                  {t('pages.mihomo.manage')}
                </Button>
              </SettingItem>
            </SettingCard>
            <PortSetting mode="all" />
            <ControllerSetting />
            <EnvSetting />
            <AdvancedSetting />
          </div>
        </details>
      </div>
    </BasePage>
  )
}

export default Mihomo
