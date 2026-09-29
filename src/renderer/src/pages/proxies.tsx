import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import ProfileNodesPreview from '@renderer/components/profiles/profile-nodes-preview'
import { useTranslation } from 'react-i18next'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { toast } from 'sonner'
import BasePage from '@renderer/components/base/base-page'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import ProxyItem from '@renderer/components/proxies/proxy-item'
import ProxySettingModal from '@renderer/components/proxies/proxy-setting-modal'
import OutboundModeSwitcher from '@renderer/components/sider/outbound-mode-switcher'
import { useGroups } from '@renderer/hooks/use-groups'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import {
  mihomoChangeProxy,
  mihomoCloseAllConnections,
  mihomoProxyDelay,
  mihomoUnfixedProxy
} from '@renderer/utils/ipc'
import { includesIgnoreCase } from '@renderer/utils/includes'
import {
  ArrowRight,
  Check,
  Ellipsis,
  Gauge,
  LocateFixed,
  MapPinOff,
  Search,
  SlidersHorizontal
} from 'lucide-react'
import dayjs from 'dayjs'
import '@renderer/components/proxies/proxies-page.css'

type Node = ControllerProxiesDetail | ControllerGroupDetail
const lastDelay = (proxy: Node): number => proxy.history.at(-1)?.delay || Infinity

const Proxies: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const fromHome = (location.state as { fromHome?: boolean } | null)?.fromHome ?? false
  const { groups = [], mutate } = useGroups()
  const { appConfig, patchAppConfig } = useAppConfig()
  const { profileConfig } = useProfileConfig()
  const { controledMihomoConfig } = useControledMihomoConfig()
  const [groupName, setGroupName] = useState(
    () => (location.state as { groupName?: string } | null)?.groupName ?? ''
  )
  const [inspectedName, setInspectedName] = useState('')
  const [search, setSearch] = useState('')
  const [testing, setTesting] = useState<Set<string>>(new Set())
  const [testingAll, setTestingAll] = useState(false)
  const [testingDetail, setTestingDetail] = useState(false)
  const [isSettingModalOpen, setIsSettingModalOpen] = useState(false)
  const [locateRequested, setLocateRequested] = useState(false)
  const testLock = useRef(false)
  const selectLock = useRef(false)
  const mutateThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<VirtuosoHandle>(null)
  const mode = controledMihomoConfig?.mode ?? 'rule'
  const visibleGroups = groups.filter((item) =>
    mode === 'global' ? item.name === 'GLOBAL' : mode === 'rule' && item.name !== 'GLOBAL'
  )
  const group = visibleGroups.find((item) => item.name === groupName) ?? visibleGroups[0]
  const current = profileConfig?.items.find((item) => item.id === profileConfig.current)
  const order = appConfig?.proxyDisplayOrder ?? 'default'
  const nodes = useMemo(() => {
    const filtered = (group?.all ?? []).filter((node) =>
      includesIgnoreCase(
        `${node.name} ${node.type} ${'serverDescription' in node ? (node.serverDescription ?? '') : ''}`,
        search
      )
    )
    if (order === 'delay') filtered.sort((a, b) => lastDelay(a) - lastDelay(b))
    if (order === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name))
    return filtered
  }, [group, order, search])
  const inspected =
    nodes.find((node) => node.name === inspectedName) ??
    nodes.find((node) => node.name === group?.now) ??
    nodes[0]
  const inspectedDelay = inspected?.history.at(-1)?.delay
  const latestTestedAt = useMemo(() => {
    const latest = nodes.reduce((maximum, node) => {
      const timestamp = Date.parse(node.history.at(-1)?.time ?? '')
      return Number.isFinite(timestamp) ? Math.max(maximum, timestamp) : maximum
    }, 0)
    return latest ? dayjs(latest).format('HH:mm') : null
  }, [nodes])

  useEffect(
    () => () => {
      if (mutateThrottleRef.current) clearTimeout(mutateThrottleRef.current)
    },
    []
  )

  useEffect(() => {
    if (!locateRequested) return
    const index = nodes.findIndex((node) => node.name === group?.now)
    if (index >= 0) listRef.current?.scrollToIndex({ index, align: 'center' })
    setLocateRequested(false)
  }, [locateRequested, nodes, group?.now])

  function scheduleGroupRefresh(): void {
    if (mutateThrottleRef.current) return
    mutateThrottleRef.current = setTimeout(() => {
      mutateThrottleRef.current = null
      mutate()
    }, 500)
  }

  async function select(groupName: string, name: string): Promise<void> {
    if (selectLock.current) return
    selectLock.current = true
    try {
      await mihomoChangeProxy(groupName, name)
      if (appConfig?.autoCloseConnection !== false) await mihomoCloseAllConnections(groupName)
    } catch (error) {
      toast.error(`${t('redesign.operationFailed')}: ${String(error)}`)
    } finally {
      await mutate()
      selectLock.current = false
    }
  }
  async function test(node: Node, url?: string): Promise<ControllerProxiesDelay> {
    return mihomoProxyDelay(
      node.name,
      url,
      'provider-name' in node ? node['provider-name'] : undefined
    )
  }
  async function testDetail(): Promise<void> {
    if (!inspected || testingDetail) return
    setTestingDetail(true)
    try {
      await test(inspected, group?.testUrl)
    } catch (error) {
      toast.error(String(error))
    } finally {
      await mutate()
      setTestingDetail(false)
    }
  }
  async function unfix(): Promise<void> {
    if (!group?.fixed) return
    try {
      await mihomoUnfixedProxy(group.name)
      mutate()
    } catch (error) {
      toast.error(String(error))
    }
  }
  function locateCurrent(): void {
    if (!group?.now) return
    setSearch('')
    setInspectedName(group.now)
    setLocateRequested(true)
  }
  async function testAll(): Promise<void> {
    if (!group || testLock.current) return
    testLock.current = true
    setTestingAll(true)
    const queue = [...nodes]
    const testUrl = group.testUrl
    setTesting(new Set(queue.map((n) => n.name)))
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < queue.length) {
        const node = queue[next++]
        try {
          await test(node, testUrl)
        } catch {
          /* A failed latency probe is displayed by the core as a timeout. */
        } finally {
          scheduleGroupRefresh()
          setTesting((prev) => {
            const remaining = new Set(prev)
            remaining.delete(node.name)
            return remaining
          })
        }
      }
    }
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(queue.length, Math.max(1, appConfig?.delayTestConcurrency || 50)) },
          worker
        )
      )
    } finally {
      if (mutateThrottleRef.current) {
        clearTimeout(mutateThrottleRef.current)
        mutateThrottleRef.current = null
      }
      mutate()
      setTesting(new Set())
      setTestingAll(false)
      testLock.current = false
    }
  }
  return (
    <BasePage
      title={t('redesign.nodesTitle')}
      showBackButton={fromHome}
      subtitle={
        <>
          {current?.name}
          {current && ' · '}
          {t('redesign.nodeCount', { count: group?.all.length ?? 0 })}
        </>
      }
      contentClassName="koala-nodes-page"
      header={
        <div className="koala-nodes-header-actions">
          <OutboundModeSwitcher modes={['rule', 'global']} />
          <Button
            size="sm"
            variant="outline"
            disabled={testingAll || !nodes.length}
            onClick={() => void testAll()}
          >
            {testingAll ? <Spinner /> : <Gauge aria-hidden="true" />}
            {t('redesign.testAll')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={t('redesign.moreSettings')}>
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={locateCurrent} disabled={!group?.now}>
                <LocateFixed aria-hidden="true" />
                {t('sider.locateCurrentNode')}
              </DropdownMenuItem>
              {(['default', 'delay', 'name'] as const).map((value) => (
                <DropdownMenuItem
                  key={value}
                  onClick={() => void patchAppConfig({ proxyDisplayOrder: value })}
                >
                  {order === value && <Check aria-hidden="true" />}
                  {t(
                    value === 'default'
                      ? 'redesign.originalOrder'
                      : value === 'delay'
                        ? 'redesign.latencyOrder'
                        : 'redesign.nameOrder'
                  )}
                </DropdownMenuItem>
              ))}
              {group?.fixed && (
                <DropdownMenuItem onClick={() => void unfix()}>
                  <MapPinOff aria-hidden="true" />
                  {t('proxies.unpin')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setIsSettingModalOpen(true)}>
                <SlidersHorizontal aria-hidden="true" />
                {t('pages.proxies.proxyGroupSettings')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/home')}>
                {t('redesign.backHome')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      {isSettingModalOpen && <ProxySettingModal onClose={() => setIsSettingModalOpen(false)} />}
      <div
        className="koala-nodes-tabs ui-group-tabs"
        role="group"
        aria-label={t('redesign.proxyStrategy')}
      >
        {visibleGroups.map((item) => (
          <button
            type="button"
            key={item.name}
            data-guide={item === visibleGroups[0] ? 'proxies-first-group' : undefined}
            data-guide-open={group?.name === item.name ? 'true' : 'false'}
            aria-pressed={group?.name === item.name}
            onClick={() => {
              if (mode === 'rule') setGroupName(item.name)
              setInspectedName('')
            }}
          >
            {item.name === 'GLOBAL' ? t('redesign.global') : item.name}
            <span>{item.all.length}</span>
          </button>
        ))}
      </div>
      {mode === 'direct' ? (
        <div className="ui-panel koala-nodes-empty">{t('sider.directMode')}</div>
      ) : (
        <div className="koala-nodes-workspace">
          <section className="koala-nodes-main" aria-label={t('redesign.nodes')}>
            <label className="koala-nodes-search">
              <Search aria-hidden="true" />
              <Input
                aria-label={t('redesign.searchNodeOrProtocol')}
                placeholder={t('redesign.searchNodeOrProtocol')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="koala-nodes-list-heading">
              <span>{t('redesign.nodeListHeading')}</span>
              <span>{t('redesign.nodeLatency')}</span>
            </div>
            <div
              data-guide="proxies-first-group-row"
              className="koala-nodes-list ui-list"
              style={
                nodes.length ? { maxHeight: `calc(${nodes.length} * 48.05px + 1px)` } : undefined
              }
            >
              {nodes.length && group ? (
                <Virtuoso
                  ref={listRef}
                  key={group.name}
                  data={nodes}
                  itemContent={(index, node) => (
                    <ProxyItem
                      proxy={node}
                      last={index === nodes.length - 1}
                      selected={node.name === group.now}
                      inspected={node.name === inspected?.name}
                      onInspect={() => setInspectedName(node.name)}
                      isGroupDelaying={
                        testing.has(node.name) || (testingDetail && inspected?.name === node.name)
                      }
                    />
                  )}
                />
              ) : (
                <div className="koala-nodes-empty">{t('redesign.noResults')}</div>
              )}
            </div>
            <p className="koala-nodes-last-tested">
              {t('redesign.lastDelayTest')} · {latestTestedAt ?? t('redesign.notTested')}
            </p>
          </section>
          <aside className="koala-node-inspector ui-panel" aria-label={t('redesign.nodeDetails')}>
            {inspected ? (
              <>
                <div className="koala-node-inspector-heading">
                  <span>{t('redesign.nodeDetails')}</span>
                  <span className="koala-node-country" aria-hidden="true">
                    {inspected.name.match(/\p{Regional_Indicator}{2}/u)?.[0] ||
                      inspected.name.slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <h2 title={inspected.name}>{inspected.name}</h2>
                <p className="koala-node-subtitle">
                  {'serverDescription' in inspected && inspected.serverDescription
                    ? inspected.serverDescription
                    : current?.name}
                </p>
                <dl>
                  <div>
                    <dt>{t('redesign.nodeProtocol')}</dt>
                    <dd>{inspected.type}</dd>
                  </div>
                  <div>
                    <dt>{t('redesign.nodeProvider')}</dt>
                    <dd
                      title={
                        'provider-name' in inspected ? inspected['provider-name'] : current?.name
                      }
                    >
                      {('provider-name' in inspected && inspected['provider-name']) ||
                        current?.name ||
                        t('redesign.notProvided')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('redesign.nodeLatency')}</dt>
                    <dd className="koala-node-latency">
                      {inspectedDelay === undefined
                        ? t('redesign.notTested')
                        : inspectedDelay === 0
                          ? t('redesign.latencyTimeout')
                          : `${inspectedDelay} ms`}
                    </dd>
                  </div>
                </dl>
                <div className="koala-node-actions">
                  <Button
                    size="sm"
                    disabled={inspected.name === group?.now || selectLock.current}
                    onClick={() => void select(group!.name, inspected.name)}
                  >
                    {inspected.name === group?.now ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <ArrowRight aria-hidden="true" />
                    )}
                    {inspected.name === group?.now
                      ? t('redesign.usingNode')
                      : t('redesign.useNode')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={testingDetail}
                    onClick={() => void testDetail()}
                  >
                    {testingDetail ? <Spinner /> : <Gauge aria-hidden="true" />}
                    {t('redesign.testLatency')}
                  </Button>
                </div>
              </>
            ) : (
              <p className="koala-nodes-empty">{t('redesign.selectToInspect')}</p>
            )}
          </aside>
        </div>
      )}
    </BasePage>
  )
}
function ProxiesPage() {
  const location = useLocation()
  const { profileConfig } = useProfileConfig()
  const requestedId = (location.state as { profileId?: string } | null)?.profileId
  const profile = profileConfig?.items.find((item) => item.id === requestedId)
  if (profile && profile.id !== profileConfig?.current)
    return <ProfileNodesPreview key={profile.id} profile={profile} />
  return <Proxies />
}
export default ProxiesPage
