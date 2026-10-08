import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { Power, ChevronRight, ExternalLink, ShieldCheck, Layers, Activity, X } from 'lucide-react'
import BasePage from '@renderer/components/base/base-page'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import EditInfoModal from '@renderer/components/profiles/edit-info-modal'
import ProxyModeTabs from '@renderer/components/home/proxy-mode-tabs'
import TrafficHistory from '@renderer/components/home/traffic-history'
import OutboundModeSwitcher from '@renderer/components/sider/outbound-mode-switcher'
import { useProxyControl } from '@renderer/hooks/use-proxy-control'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { useGroups } from '@renderer/hooks/use-groups'
import { useTrafficStore } from '@renderer/store/traffic-store'
import { useConnectionsStore } from '@renderer/store/connections-store'
import { useConnectionClock } from '@renderer/store/connection-clock'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useOverviewStore } from '@renderer/store/overview-store'
import { addProfileItem } from '@renderer/utils/ipc'
import { calcTraffic } from '@renderer/utils/calc'

const ConnectedTimer = memo(({ startedAt }: { startedAt: number | null }) => {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (startedAt === null) {
      setElapsed(0)
      return undefined
    }
    const update = (): void => setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [startedAt])
  return (
    <span>
      {[Math.floor(elapsed / 3600), Math.floor((elapsed % 3600) / 60), elapsed % 60]
        .map((value) => String(value).padStart(2, '0'))
        .join(':')}
    </span>
  )
})
ConnectedTimer.displayName = 'ConnectedTimer'

const Home: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const control = useProxyControl()
  const { profileConfig, mutateProfileConfig } = useProfileConfig()
  const { groups, error: groupsError, mutate: refreshGroups } = useGroups()
  const traffic = useTrafficStore((s) => s.traffic)
  const connectionCount = useConnectionsStore((s) => s.active.length)
  const connectionsPaused = useConnectionsStore((s) => s.isPaused)
  const connectionStartedAt = useConnectionClock((s) => s.startedAt)
  const [editing, setEditing] = useState<ProfileItem | null>(null)
  const groupName = useOverviewStore((s) => s.groupName)
  const setGroupName = useOverviewStore((s) => s.selectGroup)
  const [updatedAt, setUpdatedAt] = useState(Date.now())
  useEffect(() => {
    setUpdatedAt(Date.now())
  }, [traffic, control.runtime])
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const current = profileConfig?.items.find((item) => item.id === profileConfig.current)
  const group =
    (control.runtime?.mode === 'global'
      ? groups?.find((item) => item.name === 'GLOBAL')
      : undefined) ??
    groups?.find((item) => item.name === groupName) ??
    groups?.[0]
  const runtimeAvailable = Boolean(control.runtime && !control.runtimeError)
  const nodeAvailable = runtimeAvailable && !groupsError && groups !== undefined
  const proxyEnabled = runtimeAvailable && control.enabled
  const selectedNode = nodeAvailable
    ? group?.all.find((item) => item.name === group.now)
    : undefined
  const nodeDelay = selectedNode?.history?.at(-1)?.delay
  const direct = control.runtime?.mode === 'direct'
  const extra = current?.extra
  const usageKnown = extra?.upload !== undefined && extra?.download !== undefined
  const used = (extra?.upload ?? 0) + (extra?.download ?? 0)
  const total = extra?.total
  const quotaKnown = usageKnown && total !== undefined && total > 0
  const expires = extra?.expire
  const days =
    expires && expires > 0 ? Math.max(0, Math.ceil((expires * 1000 - now) / 86400000)) : undefined
  const expired = Boolean(expires && expires * 1000 <= now)
  const renewal = current?.home || current?.supportUrl
  const hasProfiles = Boolean(profileConfig?.items.length)
  const status = control.busy
    ? t('redesign.applying')
    : control.runtimeError
      ? t('redesign.coreUnavailable')
      : !runtimeAvailable
        ? t('redesign.loading')
        : !hasProfiles
          ? t('redesign.waitingProfile')
          : proxyEnabled
            ? t('redesign.connectionEstablished')
            : t('redesign.proxyClosed')
  const nodeName = !runtimeAvailable
    ? t('redesign.unknown')
    : direct
      ? 'DIRECT'
      : groupsError
        ? t('redesign.unknown')
        : groups === undefined
          ? t('redesign.loading')
          : group?.now || t('redesign.noNode')
  const newProfile = (): void =>
    setEditing({ id: '', name: '', type: 'remote', url: '', useProxy: false, autoUpdate: true })

  return (
    <BasePage
      title={t('redesign.overviewTitle')}
      subtitle={t('redesign.homeSubtitle')}
      header={
        <span className="ui-description">
          {t('redesign.updatedAt', {
            time: runtimeAvailable ? dayjs(updatedAt).format('HH:mm') : '—'
          })}
        </span>
      }
    >
      {!profileConfig ? (
        <div role="status" className="ui-panel flex items-center gap-2">
          <Spinner />
          {t('redesign.loading')}
        </div>
      ) : (
        <div className="ui-home-content">
          {(control.error || control.runtimeError || Boolean(groupsError)) && (
            <div role="alert" className="ui-home-alert">
              <p>
                {control.error ||
                  t(
                    groupsError && !control.runtimeError
                      ? 'redesign.nodesUnavailable'
                      : 'redesign.coreUnavailableHint'
                  )}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void control.refresh()
                  refreshGroups()
                }}
              >
                {t('redesign.refreshStatus')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate('/mihomo')}>
                {t('sider.coreSettings')}
              </Button>
              {control.error && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('common.close')}
                  onClick={control.clearError}
                >
                  <X />
                </Button>
              )}
            </div>
          )}
          <section className="ui-panel ui-home-control" aria-label={t('redesign.proxyControl')}>
            <div className="ui-home-status">
              <div className="ui-home-status-icon" data-enabled={proxyEnabled} aria-hidden>
                {proxyEnabled ? <ShieldCheck className="size-4" /> : <Power className="size-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <h2 role="status">{status}</h2>
                <div className="ui-description tabular-nums">
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="ui-home-mode-trigger"
                        aria-label={t('redesign.switchMode')}
                      >
                        {t(
                          control.mode === 'tun'
                            ? 'redesign.tunModeShort'
                            : 'redesign.systemProxyShort'
                        )}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="ui-mode-popover" align="start">
                      <ProxyModeTabs />
                    </PopoverContent>
                  </Popover>
                  {' · '}
                  {runtimeAvailable && proxyEnabled ? (
                    <>
                      {t('redesign.runningFor')} <ConnectedTimer startedAt={connectionStartedAt} />
                    </>
                  ) : (
                    t(runtimeAvailable ? 'redesign.connectForStatus' : 'redesign.unknown')
                  )}
                </div>
              </div>
              <Button
                data-guide="home-power-toggle"
                variant={proxyEnabled ? 'outline' : 'default'}
                aria-pressed={runtimeAvailable ? control.enabled : undefined}
                aria-busy={control.busy}
                disabled={
                  control.busy ||
                  !control.ready ||
                  !runtimeAvailable ||
                  (!control.enabled && (control.portDisabled || !current))
                }
                onClick={() => void control.apply(control.mode, !control.enabled)}
              >
                {control.busy ? <Spinner /> : <Power />}
                {t(proxyEnabled ? 'redesign.disableProxy' : 'redesign.enableProxy')}
              </Button>
            </div>
            <div className="ui-home-config">
              <div className="min-w-0">
                <div className="ui-home-config-label">
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="ui-home-mode-trigger"
                        disabled={direct || !nodeAvailable || (groups?.length ?? 0) < 2}
                      >
                        {t('redesign.currentExit')}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="ui-mode-popover" align="start">
                      <label className="ui-description" htmlFor="overview-strategy">
                        {t('sider.proxyGroup')}
                      </label>
                      <select
                        id="overview-strategy"
                        value={group?.name ?? ''}
                        disabled={control.runtime?.mode === 'global'}
                        onChange={(event) => setGroupName(event.target.value)}
                        className="ui-setting-select mt-2 w-full"
                      >
                        {groups?.map((item) => (
                          <option key={item.name} value={item.name}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </PopoverContent>
                  </Popover>
                </div>
                <button
                  type="button"
                  className="ui-home-node-picker"
                  data-guide={hasProfiles ? 'home-group-selector' : 'home-add-profile-btn'}
                  title={nodeName}
                  aria-label={
                    direct ? t('redesign.direct') : `${t('redesign.switchNode')}: ${nodeName}`
                  }
                  disabled={hasProfiles && (direct || !nodeAvailable || !group)}
                  onClick={() =>
                    hasProfiles
                      ? navigate('/proxies', { state: { fromHome: true, groupName: group?.name } })
                      : newProfile()
                  }
                >
                  <span className="min-w-0 flex-1 truncate">
                    {!hasProfiles
                      ? t('pages.profiles.addProfile')
                      : direct
                        ? t('redesign.directExit')
                        : nodeName}
                  </span>
                  {!direct && nodeAvailable && proxyEnabled && (
                    <span
                      className={`shrink-0 text-[11px] tabular-nums ${nodeDelay === 0 ? 'text-destructive' : 'text-muted-foreground'}`}
                    >
                      {nodeDelay === undefined || nodeDelay < 0
                        ? t('redesign.notTested')
                        : nodeDelay === 0
                          ? t('redesign.latencyTimeout')
                          : `${nodeDelay} ms`}
                    </span>
                  )}
                  {!direct && nodeAvailable && group && (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                </button>
              </div>
              <div className="min-w-0">
                <div className="ui-home-config-label">{t('redesign.outboundMode')}</div>
                <OutboundModeSwitcher />
              </div>
            </div>
            {control.portDisabled && (
              <p className="px-4 pb-3 text-[11px] text-destructive">{t('redesign.portDisabled')}</p>
            )}
          </section>
          <div className="ui-home-summary">
            <section className="ui-panel" aria-label={t('redesign.realtimeTraffic')}>
              <div className="flex items-center justify-between gap-2">
                <h2>{t('redesign.realtimeTraffic')}</h2>
                <span className="ui-description">{t('redesign.recentMinute')}</span>
              </div>
              <div className="ui-home-metrics">
                {(
                  [
                    ['down', '↓', 'download'],
                    ['up', '↑', 'upload']
                  ] as const
                ).map(([key, arrow, label]) => (
                  <div key={key}>
                    <p className="ui-description">
                      {arrow} {t(`redesign.${label}`)}
                    </p>
                    <p className="ui-metric-value">
                      {runtimeAvailable ? calcTraffic(traffic[key]).split(' ')[0] : '—'}
                      <small>
                        {runtimeAvailable ? calcTraffic(traffic[key]).split(' ')[1] : 'B'}/s
                      </small>
                    </p>
                  </div>
                ))}
              </div>
              <TrafficHistory available={runtimeAvailable} />
            </section>
            <section className="ui-panel" aria-label={t('redesign.connectionOverview')}>
              <div className="flex items-center justify-between gap-2">
                <h2>{t('redesign.connectionOverview')}</h2>
                <Activity className="size-4 text-muted-foreground" />
              </div>
              <div className="ui-home-connections-total">
                <div className="ui-metric-value">
                  {runtimeAvailable ? connectionCount : '—'}
                  <small>{t('redesign.activeConnections')}</small>
                </div>
              </div>
              {connectionsPaused && <p className="ui-description">{t('redesign.refreshPaused')}</p>}
              <dl>
                <div className="ui-summary-row">
                  <dt>{t('redesign.downloadTotal')}</dt>
                  <dd>{runtimeAvailable ? calcTraffic(traffic.downTotal) : '—'}</dd>
                </div>
                <div className="ui-summary-row">
                  <dt>{t('redesign.uploadTotal')}</dt>
                  <dd>{runtimeAvailable ? calcTraffic(traffic.upTotal) : '—'}</dd>
                </div>
              </dl>
              <button
                type="button"
                className="ui-summary-link"
                onClick={() => navigate('/connections')}
              >
                {t('redesign.viewConnections')}
                <ChevronRight className="size-3.5" />
              </button>
            </section>
          </div>
          <section className="ui-panel ui-home-profile" aria-label={t('redesign.currentProfile')}>
            <div className="ui-home-profile-summary" data-guide="home-profile-header">
              <Layers className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                {current?.announce || current?.supportUrl ? (
                  <details className="ui-home-profile-announcement">
                    <summary className="truncate" title={t('redesign.subscriptionInformation')}>
                      {current.name}
                    </summary>
                    <div className="ui-home-profile-announcement-content">
                      <h2>{t('redesign.subscriptionInformation')}</h2>
                      {current.announce && (
                        <p data-guide="home-profile-announce" className="select-text">
                          {current.announce}
                        </p>
                      )}
                      {current.supportUrl && (
                        <Button
                          data-guide="home-support-link"
                          variant="link"
                          size="sm"
                          onClick={() => open(current.supportUrl)}
                        >
                          {t('pages.profiles.support')}
                          <ExternalLink />
                        </Button>
                      )}
                    </div>
                  </details>
                ) : (
                  <h2 className="truncate" title={current?.name}>
                    {current?.name || t('pages.home.noProfile')}
                  </h2>
                )}
                <div className="ui-home-profile-info">
                  <span>
                    {t('redesign.remainingQuota')}{' '}
                    {quotaKnown
                      ? `${calcTraffic(Math.max(0, total - used))} / ${calcTraffic(total)}`
                      : t('redesign.notProvided')}
                  </span>
                  <span>
                    {expires && expires > 0
                      ? expired
                        ? t('pages.home.subscriptionExpired')
                        : t('redesign.expiresInDays', { count: days })
                      : t('profile.longTermValid')}
                  </span>
                </div>
              </div>
              <div className="ui-toolbar">
                <Button size="sm" variant="ghost" onClick={() => navigate('/profiles')}>
                  <ChevronRight />
                  {t('redesign.manageProfile')}
                </Button>
              </div>
            </div>
            {days !== undefined && days <= 3 && (
              <div role="status" className="ui-home-alert mt-3">
                <p className="text-destructive">
                  {expired
                    ? t('pages.home.subscriptionExpired')
                    : t('pages.home.subscriptionExpiring', { count: days })}
                </p>
                {renewal && (
                  <Button size="sm" variant="outline" onClick={() => open(renewal)}>
                    {t('pages.home.renewSubscription')}
                  </Button>
                )}
              </div>
            )}
          </section>
        </div>
      )}
      {editing && (
        <EditInfoModal
          item={editing}
          isCurrent={false}
          onClose={() => setEditing(null)}
          updateProfileItem={async (item) => {
            await addProfileItem(item)
            mutateProfileConfig()
            setEditing(null)
          }}
        />
      )}
    </BasePage>
  )
}
export default Home
