import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Activity,
  Cpu,
  LayoutDashboard,
  Layers,
  ListFilter,
  Orbit,
  SlidersHorizontal,
  Terminal
} from 'lucide-react'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useProxyControl } from '@renderer/hooks/use-proxy-control'
import ConfigViewer from '@renderer/components/sider/config-viewer'
import brandMark from '@renderer/assets/brand-mark.svg'

export const workspacePages = [
  { key: 'main', path: '/home', icon: LayoutDashboard, i18nKey: 'redesign.overviewTitle' },
  { key: 'proxy', path: '/proxies', icon: Orbit, i18nKey: 'redesign.nodesTitle' },
  { key: 'profile', path: '/profiles', icon: Layers, i18nKey: 'redesign.profilesTitle' },
  { key: 'connection', path: '/connections', icon: Activity, i18nKey: 'sider.connection' },
  { key: 'rule', path: '/rules', icon: ListFilter, i18nKey: 'sider.rules' },
  { key: 'log', path: '/logs', icon: Terminal, i18nKey: 'sider.logs' },
  { key: 'core', path: '/mihomo', icon: Cpu, i18nKey: 'redesign.coreTitle' },
  { key: 'settings', path: '/settings', icon: SlidersHorizontal, i18nKey: 'redesign.settingsTitle' }
]

export default function AppSidebar() {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { state } = useSidebar()
  const { runtime, runtimeError } = useProxyControl()
  const coreState = runtimeError ? 'error' : runtime ? 'on' : 'loading'
  const collapsed = state === 'collapsed'
  const [showRuntimeConfig, setShowRuntimeConfig] = useState(false)
  return (
    <aside className="ui-sidebar" data-guide="app-sidebar" data-collapsed={collapsed}>
      <div className="ui-sidebar-brand app-drag" aria-label="Koala">
        <div
          className="ui-brand-mark"
          aria-hidden="true"
          style={{ maskImage: `url("${brandMark}")` }}
        />
        <span>Koala</span>
      </div>
      <nav className="ui-sidebar-nav" aria-label={t('redesign.workspace')}>
        {workspacePages.map((item) => {
          const Icon = item.icon
          const active =
            location.pathname === item.path || location.pathname.startsWith(`${item.path}/`)
          return (
            <button
              key={item.key}
              type="button"
              className="ui-nav-button"
              aria-label={t(item.i18nKey)}
              title={collapsed ? t(item.i18nKey) : undefined}
              aria-current={active ? 'page' : undefined}
              data-active={active}
              data-guide={item.key === 'main' ? 'sidebar-home-button' : undefined}
              onClick={() => navigate(item.path)}
              onDoubleClick={item.key === 'profile' ? () => setShowRuntimeConfig(true) : undefined}
            >
              <Icon aria-hidden />
              <span>{t(item.i18nKey)}</span>
            </button>
          )
        })}
      </nav>
      <div className="ui-sidebar-foot" role="status">
        <div className="ui-sidebar-core">
          <span className="ui-dot" data-state={coreState} aria-hidden="true" /> <span>Mihomo</span>
        </div>
        <p>
          {t(
            coreState === 'error'
              ? 'redesign.coreUnavailable'
              : coreState === 'on'
                ? 'redesign.coreRunning'
                : 'redesign.loading'
          )}
        </p>
      </div>
      {showRuntimeConfig && <ConfigViewer onClose={() => setShowRuntimeConfig(false)} />}
    </aside>
  )
}
