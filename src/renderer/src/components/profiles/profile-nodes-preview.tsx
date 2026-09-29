import { useMemo, useState } from 'react'
import useSWR from 'swr'
import yaml from 'js-yaml'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
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
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { changeCurrentProfile, getProfileStr } from '@renderer/utils/ipc'
import { includesIgnoreCase } from '@renderer/utils/includes'
import { Ellipsis, Search } from 'lucide-react'
import '@renderer/components/proxies/proxies-page.css'

interface PreviewNode {
  name: string
  type: string
}
interface PreviewGroup {
  name: string
  proxies: string[]
}

export default function ProfileNodesPreview({ profile }: { profile: ProfileItem }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { mutateProfileConfig } = useProfileConfig()
  const [search, setSearch] = useState('')
  const [selectedGroup, setSelectedGroup] = useState('')
  const [inspectedName, setInspectedName] = useState('')
  const [activating, setActivating] = useState(false)
  const { data, error } = useSWR(['profileNodePreview', profile.id], async () => {
    const parsed = yaml.load(await getProfileStr(profile.id)) as Record<string, unknown> | null
    const nodes: PreviewNode[] = []
    const groups: PreviewGroup[] = []
    if (Array.isArray(parsed?.proxies))
      for (const node of parsed.proxies) {
        if (node && typeof node.name === 'string' && typeof node.type === 'string')
          nodes.push({ name: node.name, type: node.type })
      }
    if (Array.isArray(parsed?.['proxy-groups']))
      for (const group of parsed['proxy-groups']) {
        if (group && typeof group.name === 'string')
          groups.push({
            name: group.name,
            proxies: Array.isArray(group.proxies)
              ? group.proxies.filter((name: unknown) => typeof name === 'string')
              : []
          })
      }
    return { nodes, groups, hasProviders: Boolean(parsed?.['proxy-providers']) }
  })
  const group = data?.groups.find((item) => item.name === selectedGroup) ?? data?.groups[0]
  const nodes = useMemo(
    () =>
      (data?.nodes ?? []).filter(
        (node) =>
          (!group || group.proxies.includes(node.name)) &&
          includesIgnoreCase(`${node.name} ${node.type}`, search)
      ),
    [data, group, search]
  )
  const inspected = nodes.find((node) => node.name === inspectedName) ?? nodes[0]
  async function activate(): Promise<void> {
    if (activating) return
    setActivating(true)
    try {
      await changeCurrentProfile(profile.id)
      await mutateProfileConfig()
      window.electron.ipcRenderer.send('updateTrayMenu')
      navigate('/proxies', { replace: true })
    } catch (cause) {
      toast.error(String(cause))
    } finally {
      setActivating(false)
    }
  }
  return (
    <BasePage
      title={t('redesign.nodesTitle')}
      showBackButton
      subtitle={`${profile.name} · ${t('redesign.nodeCount', { count: data?.nodes.length ?? 0 })}`}
      contentClassName="koala-nodes-page"
      header={
        <div className="koala-nodes-header-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={t('redesign.moreSettings')}>
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigate('/home')}>
                {t('redesign.backHome')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      <div
        className="koala-nodes-tabs ui-group-tabs"
        role="group"
        aria-label={t('redesign.proxyStrategy')}
      >
        {data?.groups.map((item) => (
          <button
            type="button"
            key={item.name}
            aria-pressed={group?.name === item.name}
            onClick={() => {
              setSelectedGroup(item.name)
              setInspectedName('')
            }}
          >
            {item.name}
            <span>{item.proxies.length}</span>
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="ui-panel text-destructive">
          {t('redesign.operationFailed')}: {String(error)}
        </p>
      ) : !data ? (
        <div className="ui-panel">
          <Spinner />
        </div>
      ) : (
        <div className="koala-nodes-workspace">
          <section className="koala-nodes-main" aria-label={t('redesign.nodes')}>
            <label className="koala-nodes-search">
              <Search aria-hidden="true" />
              <Input
                aria-label={t('redesign.searchNodeOrProtocol')}
                placeholder={t('redesign.searchNodeOrProtocol')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="koala-nodes-list-heading">
              <span>{t('redesign.nodeListHeading')}</span>
              <span>{t('redesign.nodeLatency')}</span>
            </div>
            <div
              className="koala-nodes-list ui-list"
              style={
                nodes.length ? { maxHeight: `calc(${nodes.length} * 48.05px + 1px)` } : undefined
              }
            >
              {nodes.length ? (
                <Virtuoso
                  data={nodes}
                  itemContent={(index, node) => (
                    <button
                      type="button"
                      className="koala-preview-node-row"
                      data-last={index === nodes.length - 1}
                      aria-pressed={inspected?.name === node.name}
                      onClick={() => setInspectedName(node.name)}
                    >
                      <span className="koala-node-country" aria-hidden="true">
                        {node.name.match(/\p{Regional_Indicator}{2}/u)?.[0] ||
                          node.name.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="koala-node-row-label">
                        <span className="koala-node-row-name" title={node.name}>
                          {node.name}
                        </span>
                        <span className="koala-node-row-type">{node.type}</span>
                      </span>
                      <span className="koala-node-row-status">{t('redesign.notTested')}</span>
                    </button>
                  )}
                />
              ) : (
                <div className="koala-nodes-empty">{t('redesign.noResults')}</div>
              )}
            </div>
            {data.hasProviders && (
              <p className="koala-nodes-last-tested">{t('redesign.previewProviderHint')}</p>
            )}
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
                <p className="koala-node-subtitle">{profile.name}</p>
                <dl>
                  <div>
                    <dt>{t('redesign.nodeProtocol')}</dt>
                    <dd>{inspected.type}</dd>
                  </div>
                  <div>
                    <dt>{t('redesign.nodeProvider')}</dt>
                    <dd>{profile.name}</dd>
                  </div>
                  <div>
                    <dt>{t('redesign.nodeLatency')}</dt>
                    <dd>{t('redesign.notTested')}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className="koala-node-subtitle">
                {data.hasProviders ? t('redesign.previewProviderHint') : t('redesign.noResults')}
              </p>
            )}
            <div className="koala-node-actions">
              <Button disabled={activating} onClick={() => void activate()}>
                {activating && <Spinner />}
                {t('redesign.useProfile')}
              </Button>
            </div>
          </aside>
        </div>
      )}
    </BasePage>
  )
}
