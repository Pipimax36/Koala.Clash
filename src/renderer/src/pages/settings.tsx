import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import useSWR, { mutate } from 'swr'
import { toast } from 'sonner'
import { ArrowUpRight, Github } from 'lucide-react'
import { appRepositoryUrl } from '../../../shared/app-update'
import appIcon from '../../../../resources/icon.png'
import BasePage from '@renderer/components/base/base-page'
import ConfirmModal from '@renderer/components/base/base-confirm'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import GeneralConfig from '@renderer/components/settings/general-config'
import AdvancedSettings from '@renderer/components/settings/advanced-settings'
import Actions from '@renderer/components/settings/actions'
import CheckUpdateButton from '@renderer/components/updater/check-update-button'
import ShortcutConfig from '@renderer/components/settings/shortcut-config'
import AppearanceConfig from '@renderer/components/settings/appearance-confis'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useLanguage, type Language } from '@renderer/hooks/use-language'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { useProxyControl } from '@renderer/hooks/use-proxy-control'
import type { ProxyMode } from '@renderer/utils/proxy-control'
import { platform, version } from '@renderer/utils/init'
import {
  checkAutoRun,
  disableAutoRun,
  enableAutoRun,
  mihomoCloseAllConnections,
  patchControledMihomoConfig,
  patchMihomoConfig
} from '@renderer/utils/ipc'
import '@renderer/components/settings/settings-layout.css'

type SettingsCategory = 'appearance' | 'startup' | 'network' | 'shortcuts' | 'about' | 'more'

function SettingsRow({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ks-settings-row">
      <div className="ks-settings-row-copy">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {children}
    </div>
  )
}

const Settings: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { currentLanguage, changeLanguage, languages } = useLanguage()
  const { appConfig, patchAppConfig } = useAppConfig()
  const { profileConfig } = useProfileConfig()
  const control = useProxyControl()
  const { data: autoStart, mutate: refreshAutoStart } = useSWR('checkAutoRun', checkAutoRun)
  const pageRef = useRef<HTMLDivElement>(null)
  const modeChangeLocked = useRef(false)
  const [category, setCategory] = useState<SettingsCategory>('appearance')
  const [pendingProxyMode, setPendingProxyMode] = useState<ProxyMode | null>(null)
  const [modeBusy, setModeBusy] = useState(false)
  const [showHiddenSettings, setShowHiddenSettings] = useState(false)
  const currentProfile = profileConfig?.items?.find((item) => item.id === profileConfig.current)

  const categories: Array<[SettingsCategory, string]> = [
    ['appearance', t('redesign.appearance')],
    ['startup', t('redesign.startupWindow')],
    ['network', t('redesign.network', { defaultValue: '网络' })],
    ['shortcuts', t('settings.shortcuts.title')],
    ['about', t('redesign.about', { defaultValue: '关于' })],
    ['more', t('settings.advanced.moreSettings')]
  ]

  async function changeOutboundMode(nextMode: OutboundMode): Promise<void> {
    if (modeChangeLocked.current || !control.runtime || nextMode === control.runtime.mode) return
    modeChangeLocked.current = true
    setModeBusy(true)
    const previous = control.runtime.mode
    try {
      await patchMihomoConfig({ mode: nextMode })
      try {
        await patchControledMihomoConfig({ mode: nextMode })
      } catch (cause) {
        const recovery = await Promise.allSettled([
          patchControledMihomoConfig({ mode: previous }),
          patchMihomoConfig({ mode: previous })
        ])
        if (recovery.some((result) => result.status === 'rejected')) {
          throw new AggregateError([cause], t('redesign.recoveryFailed'))
        }
        throw cause
      }
      if (appConfig?.autoCloseConnection !== false) await mihomoCloseAllConnections()
    } catch (cause) {
      toast.error(t('redesign.operationFailed') + ': ' + String(cause))
    } finally {
      await Promise.allSettled([
        control.refresh(),
        mutate('getControledMihomoConfig'),
        mutate('mihomoGroups')
      ])
      window.electron.ipcRenderer.send('updateTrayMenu')
      modeChangeLocked.current = false
      setModeBusy(false)
    }
  }

  return (
    <BasePage
      ref={pageRef}
      title={t('redesign.settingsTitle')}
      subtitle={t('redesign.settingsSubtitle')}
      contentClassName="ks-settings-content"
    >
      {pendingProxyMode && (
        <ConfirmModal
          title={t('redesign.switchMode')}
          description={t('redesign.switchModeHint')}
          onChange={(open) => {
            if (!open) setPendingProxyMode(null)
          }}
          onConfirm={async () => {
            const next = pendingProxyMode
            setPendingProxyMode(null)
            await control.apply(next, true)
          }}
        />
      )}
      <div className="ks-settings-layout">
        <nav className="ks-settings-nav" aria-label={t('redesign.settingsTitle')}>
          {categories.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="ks-settings-nav-button"
              aria-pressed={category === key}
              onClick={() => {
                setCategory(key)
                pageRef.current?.querySelector('.ui-page')?.scrollTo({ top: 0 })
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="ks-settings-panel">
          {category === 'appearance' && (
            <>
              <h2>{t('redesign.appearance')}</h2>
              <SettingsRow
                title={t('settings.appearance.theme')}
                description={t('redesign.themeDescription')}
              >
                <select
                  className="ks-setting-select"
                  aria-label={t('settings.appearance.theme')}
                  value={appConfig?.appTheme ?? 'system'}
                  onChange={(event) =>
                    void patchAppConfig({ appTheme: event.target.value as AppTheme })
                  }
                >
                  <option value="system">
                    {t('redesign.followSystem', { defaultValue: '跟随系统' })}
                  </option>
                  <option value="light">{t('settings.appearance.light')}</option>
                  <option value="dark">{t('settings.appearance.dark')}</option>
                </select>
              </SettingsRow>
              <SettingsRow
                title={t('redesign.density')}
                description={t('redesign.densityDescription')}
              >
                <select
                  className="ks-setting-select"
                  aria-label={t('redesign.density')}
                  value={appConfig?.uiDensity ?? 'comfortable'}
                  onChange={(event) =>
                    void patchAppConfig({
                      uiDensity: event.target.value as 'comfortable' | 'compact'
                    })
                  }
                >
                  <option value="comfortable">
                    {t('redesign.standard', { defaultValue: '标准' })}
                  </option>
                  <option value="compact">{t('redesign.compact')}</option>
                </select>
              </SettingsRow>
              <SettingsRow
                title={t('settings.appearance.language')}
                description={t('redesign.languageDescription', {
                  defaultValue: '选择应用界面使用的语言'
                })}
              >
                <select
                  className="ks-setting-select"
                  aria-label={t('settings.appearance.language')}
                  value={currentLanguage}
                  onChange={(event) => changeLanguage(event.target.value as Language)}
                >
                  {languages.map((language) => (
                    <option key={language.value} value={language.value}>
                      {language.nativeLabel}
                    </option>
                  ))}
                </select>
              </SettingsRow>
              {platform !== 'linux' && (
                <SettingsRow
                  title={t('settings.appearance.trayShowNodeInfo')}
                  description={t('redesign.trayNodeDescription', {
                    defaultValue: '在菜单栏中显示当前代理节点'
                  })}
                >
                  <Switch
                    className="ks-setting-toggle"
                    aria-label={t('settings.appearance.trayShowNodeInfo')}
                    checked={appConfig?.proxyInTray !== false}
                    onCheckedChange={(checked) => void patchAppConfig({ proxyInTray: checked })}
                  />
                </SettingsRow>
              )}
            </>
          )}
          {category === 'startup' && (
            <>
              <h2>{t('redesign.startupWindow')}</h2>
              <SettingsRow
                title={t('redesign.launchAtLogin', { defaultValue: '登录后启动' })}
                description={t('redesign.startupDescription')}
              >
                <Switch
                  className="ks-setting-toggle"
                  aria-label={t('settings.general.autoStart')}
                  disabled={autoStart === undefined}
                  checked={Boolean(autoStart)}
                  onCheckedChange={async (checked) => {
                    try {
                      if (checked) await enableAutoRun()
                      else await disableAutoRun()
                    } catch (error) {
                      toast.error(String(error))
                    } finally {
                      void refreshAutoStart()
                    }
                  }}
                />
              </SettingsRow>
              <SettingsRow
                title={t('redesign.minimizeOnClose')}
                description={t('redesign.minimizeDescription')}
              >
                <Switch
                  className="ks-setting-toggle"
                  aria-label={t('redesign.minimizeOnClose')}
                  checked={appConfig?.minimizeOnClose !== false}
                  onCheckedChange={(checked) => void patchAppConfig({ minimizeOnClose: checked })}
                />
              </SettingsRow>
              <SettingsRow
                title={t('settings.general.autoCheckUpdate')}
                description={t('redesign.autoUpdateDescription', {
                  defaultValue: '应用启动时检查新版本'
                })}
              >
                <Switch
                  className="ks-setting-toggle"
                  aria-label={t('settings.general.autoCheckUpdate')}
                  checked={appConfig?.autoCheckUpdate ?? false}
                  onCheckedChange={(checked) => void patchAppConfig({ autoCheckUpdate: checked })}
                />
              </SettingsRow>
            </>
          )}
          {category === 'network' && (
            <>
              <h2>{t('redesign.network', { defaultValue: '网络' })}</h2>
              <SettingsRow
                title={t('redesign.proxyMethod', { defaultValue: '代理方式' })}
                description={t('redesign.proxyMethodDescription', {
                  defaultValue: '系统代理或 TUN 虚拟网卡'
                })}
              >
                <select
                  className="ks-setting-select"
                  aria-label={t('redesign.proxyMethod', { defaultValue: '代理方式' })}
                  value={control.mode}
                  disabled={control.busy || !control.ready}
                  onChange={(event) => {
                    const next = event.target.value as ProxyMode
                    if (next === control.mode) return
                    if (control.enabled) setPendingProxyMode(next)
                    else void control.apply(next)
                  }}
                >
                  <option value="sysproxy">{t('redesign.systemProxyShort')}</option>
                  <option value="tun">{t('redesign.tunModeShort')}</option>
                </select>
              </SettingsRow>
              <SettingsRow
                title={t('redesign.outboundMode')}
                description={t('redesign.outboundDescription', {
                  defaultValue: '控制流量是否经过代理'
                })}
              >
                <select
                  className="ks-setting-select"
                  aria-label={t('redesign.outboundMode')}
                  value={control.runtime?.mode ?? ''}
                  disabled={modeBusy || !control.runtime || Boolean(control.runtimeError)}
                  onChange={(event) => void changeOutboundMode(event.target.value as OutboundMode)}
                >
                  {!control.runtime && <option value="">{t('redesign.unknown')}</option>}
                  <option value="rule">{t('redesign.rule')}</option>
                  <option value="global" disabled={currentProfile?.globalMode === false}>
                    {t('redesign.global')}
                  </option>
                  <option value="direct">{t('redesign.direct')}</option>
                </select>
              </SettingsRow>
              <SettingsRow
                title={t('redesign.listenPermission', { defaultValue: '监听与权限' })}
                description={t('redesign.listenPermissionDescription', {
                  defaultValue: '管理端口、局域网访问和运行权限'
                })}
              >
                <button
                  type="button"
                  className="ks-settings-link"
                  onClick={() => navigate('/mihomo')}
                >
                  {t('sider.coreSettings')}
                  <ArrowUpRight aria-hidden="true" />
                </button>
              </SettingsRow>
            </>
          )}
          {category === 'shortcuts' && <ShortcutConfig />}
          {category === 'about' && (
            <>
              <h2>{t('redesign.aboutKoala', { defaultValue: '关于 Koala' })}</h2>
              <div className="ks-settings-about">
                <img
                  className="ks-settings-app-icon"
                  src={appIcon}
                  alt="Koala"
                  width={64}
                  height={64}
                  draggable={false}
                />
                <h2>Koala Studio</h2>
                <p>{version ? 'v' + version : 'Koala'}</p>
                <CheckUpdateButton variant="outline" className="mt-4" />
              </div>
              <SettingsRow title={t('pages.settings.githubRepo')} description={appRepositoryUrl}>
                <Button variant="outline" onClick={() => window.open(appRepositoryUrl)}>
                  <Github aria-hidden="true" />
                  {t('pages.settings.githubRepo')}
                </Button>
              </SettingsRow>
            </>
          )}
          {category === 'more' && (
            <div className="ks-settings-more">
              <h2>{t('settings.advanced.moreSettings')}</h2>
              <AppearanceConfig showHiddenSettings={showHiddenSettings} />
              <GeneralConfig showHiddenSettings={showHiddenSettings} />
              <AdvancedSettings showHiddenSettings={showHiddenSettings} />
              <Actions
                showHiddenSettings={showHiddenSettings}
                onUnlockHiddenSettings={() => setShowHiddenSettings(true)}
              />
            </div>
          )}
        </div>
      </div>
    </BasePage>
  )
}

export default Settings
