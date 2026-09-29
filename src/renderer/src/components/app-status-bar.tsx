import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useProxyControl } from '@renderer/hooks/use-proxy-control'
import { useConnectionClock } from '@renderer/store/connection-clock'
import { useGroups } from '@renderer/hooks/use-groups'
import { useOverviewStore } from '@renderer/store/overview-store'

export default function AppStatusBar() {
  const { t } = useTranslation()
  const control = useProxyControl()
  const { groups, error: groupsError } = useGroups()
  const groupName = useOverviewStore((s) => s.groupName)
  const observeConnected = useConnectionClock((state) => state.observeConnected)
  const runtimeAvailable = Boolean(control.runtime && !control.runtimeError)
  const group =
    (control.runtime?.mode === 'global'
      ? groups?.find((item) => item.name === 'GLOBAL')
      : undefined) ??
    groups?.find((item) => item.name === groupName) ??
    groups?.[0]
  const node = group?.all.find((item) => item.name === group.now)
  const delay = node?.history?.at(-1)?.delay
  const exit =
    !runtimeAvailable || !control.enabled
      ? '—'
      : control.runtime?.mode === 'direct'
        ? 'DIRECT'
        : groupsError
          ? '—'
          : (group?.now ?? '—')
  useEffect(() => {
    observeConnected(runtimeAvailable && control.enabled)
  }, [runtimeAvailable, control.enabled, observeConnected])
  return (
    <footer className="ui-app-status" aria-live="polite">
      <span className="ui-status-label">
        <span
          className="ui-app-status-indicator"
          data-state={
            control.runtimeError ? 'error' : runtimeAvailable && control.enabled ? 'on' : 'off'
          }
          aria-hidden
        />
        <span>
          {t(
            control.runtimeError
              ? 'redesign.coreUnavailable'
              : !runtimeAvailable
                ? 'redesign.loading'
                : control.enabled
                  ? 'redesign.proxyOn'
                  : 'redesign.proxyDisconnected'
          )}
        </span>
        {runtimeAvailable && (
          <>
            <span>·</span>
            <span>
              {t('redesign.routingMode', { mode: t(`redesign.${control.runtime?.mode}`) })}
            </span>
          </>
        )}
      </span>
      <span className="ui-status-node" title={exit}>
        {exit}
        {exit !== '—' && exit !== 'DIRECT' && delay !== undefined && delay > 0
          ? ` · ${delay} ms`
          : ''}
      </span>
    </footer>
  )
}
