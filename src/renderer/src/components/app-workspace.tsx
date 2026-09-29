import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import { Moon, Sun, PanelLeft } from 'lucide-react'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { Button } from '@renderer/components/ui/button'
import WindowControls from '@renderer/components/window-controls'
import AppStatusBar from '@renderer/components/app-status-bar'
import { workspacePages } from '@renderer/components/app-sidebar'

export default function AppWorkspace({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const { resolvedTheme } = useTheme()
  const { appConfig, patchAppConfig } = useAppConfig()
  const { state, setOpen } = useSidebar()
  const page = workspacePages.find(
    (item) => pathname === item.path || pathname.startsWith(`${item.path}/`)
  )
  return (
    <div className="ui-workspace">
      <header className="ui-app-topbar app-drag">
        <div className="ui-breadcrumb">
          {state === 'collapsed' && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="app-nodrag"
              onClick={() => setOpen(true)}
              aria-label={t('common.toggleSidebar')}
            >
              <PanelLeft />
            </Button>
          )}
          <span>Koala</span>
          <span>/</span>
          <b>{page ? t(page.i18nKey) : t('redesign.details')}</b>
        </div>
        <div className="ui-window-actions app-nodrag">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('redesign.toggleTheme')}
            onClick={() =>
              void patchAppConfig({ appTheme: resolvedTheme === 'dark' ? 'light' : 'dark' })
            }
          >
            {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
          </Button>
          {!appConfig?.useWindowFrame && <WindowControls />}
        </div>
      </header>
      <div className="main min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
      <AppStatusBar />
    </div>
  )
}
