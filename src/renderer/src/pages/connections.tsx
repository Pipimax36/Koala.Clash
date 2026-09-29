import BasePage from '@renderer/components/base/base-page'
import { mihomoCloseAllConnections, mihomoCloseConnection } from '@renderer/utils/ipc'
import { useConnectionsStore } from '@renderer/store/connections-store'
import React, { useCallback, useMemo, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { calcTraffic } from '@renderer/utils/calc'
import ConnectionItem from '@renderer/components/connections/connection-item'
import ConnectionTable from '@renderer/components/connections/connection-table'
import ProcessItem, { ProcessGroup } from '@renderer/components/connections/process-item'
import ConnectionsEmpty from '@renderer/components/connections/connections-empty'
import { Virtuoso } from 'react-virtuoso'
import dayjs from 'dayjs'
import ConnectionDetailModal from '@renderer/components/connections/connection-detail-modal'
import ConnectionInspector from '@renderer/components/connections/connection-inspector'
import ConnectionSettingModal from '@renderer/components/connections/connection-setting-modal'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { includesIgnoreCase } from '@renderer/utils/includes'
import { useIconsStore, useProcessAppName, useProcessIcon } from '@renderer/store/icons-store'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { useTranslation } from 'react-i18next'
import {
  AppWindow,
  ArrowDownNarrowWide,
  ArrowDownWideNarrow,
  ArrowLeft,
  History,
  Ellipsis,
  Pause,
  Play,
  Search,
  SearchX,
  SlidersHorizontal,
  Table2,
  TableOfContents,
  Unplug
} from 'lucide-react'
import '@renderer/components/connections/connections-page.css'

const processKey = (connection: ControllerConnectionDetail): string =>
  connection.metadata.processPath ||
  connection.metadata.process ||
  connection.metadata.sourceIP ||
  ''

const matchesConnectionQuery = (
  connection: ControllerConnectionDetail,
  query: string,
  appName?: string
): boolean =>
  includesIgnoreCase(
    [
      connection.metadata.process,
      connection.metadata.processPath,
      appName,
      connection.metadata.host,
      connection.metadata.sniffHost,
      connection.metadata.destinationIP,
      connection.metadata.remoteDestination,
      connection.metadata.sourceIP,
      ...connection.chains,
      connection.rule,
      connection.rulePayload
    ]
      .filter(Boolean)
      .join(' '),
    query
  )

const Connections: React.FC = () => {
  const { t } = useTranslation()
  const { controledMihomoConfig } = useControledMihomoConfig()
  const { 'find-process-mode': findProcessMode = 'always' } = controledMihomoConfig || {}
  const [filter, setFilter] = useState('')
  const [outboundFilter, setOutboundFilter] = useState<'all' | 'proxy' | 'direct'>('all')
  const { appConfig, patchAppConfig } = useAppConfig()
  const appNames = useIconsStore((s) => s.appNames)
  const {
    connectionDirection = 'asc',
    connectionOrderBy = 'time',
    connectionListMode = 'classic',
    connectionViewMode = 'list',
    connectionTableColumns = [
      'status',
      'establishTime',
      'type',
      'host',
      'process',
      'rule',
      'proxyChain',
      'remoteDestination',
      'uploadSpeed',
      'downloadSpeed',
      'upload',
      'download'
    ],
    connectionTableColumnWidths,
    connectionTableSortColumn,
    connectionTableSortDirection,
    displayIcon = true,
    displayAppName = true
  } = appConfig || {}
  const info = useConnectionsStore((s) => s.info)
  const activeConnections = useConnectionsStore((s) => s.active)
  const closedConnections = useConnectionsStore((s) => s.closed)
  const isPaused = useConnectionsStore((s) => s.isPaused)
  const togglePause = useConnectionsStore((s) => s.togglePause)
  const removeClosedById = useConnectionsStore((s) => s.removeClosedById)
  const clearAllClosed = useConnectionsStore((s) => s.clearAllClosed)

  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false)
  const [isSettingModalOpen, setIsSettingModalOpen] = useState(false)
  const [selected, setSelected] = useState<ControllerConnectionDetail>()
  const [selectedId, setSelectedId] = useState<string>()

  const [tab, setTab] = useState('active')
  const [viewMode, setViewMode] = useState<'list' | 'table'>(connectionViewMode)
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(new Set(connectionTableColumns))

  // Two-level navigation: null = process list, string = selected process path
  const [selectedProcess, setSelectedProcess] = useState<string | null>(null)

  const columnOptions = useMemo(
    () => [
      { key: 'status', label: t('connections.detail.status') },
      { key: 'establishTime', label: t('connections.detail.establishTime') },
      { key: 'type', label: t('connections.detail.connectionType') },
      { key: 'host', label: t('connections.detail.host') },
      { key: 'sniffHost', label: t('connections.detail.sniffHost') },
      { key: 'process', label: t('connections.detail.processName') },
      { key: 'processPath', label: t('connections.detail.processPath') },
      { key: 'rule', label: t('connections.detail.rule') },
      { key: 'proxyChain', label: t('connections.detail.proxyChain') },
      { key: 'sourceIP', label: t('connections.detail.sourceIP') },
      { key: 'sourcePort', label: t('connections.detail.sourcePort') },
      { key: 'destinationPort', label: t('connections.detail.destinationPort') },
      { key: 'inboundIP', label: t('connections.detail.inboundIP') },
      { key: 'inboundPort', label: t('connections.detail.inboundPort') },
      { key: 'uploadSpeed', label: t('pages.connections.uploadSpeed') },
      { key: 'downloadSpeed', label: t('pages.connections.downloadSpeed') },
      { key: 'upload', label: t('pages.connections.uploadAmount') },
      { key: 'download', label: t('pages.connections.downloadAmount') },
      { key: 'dscp', label: t('connections.detail.dscp') },
      { key: 'remoteDestination', label: t('connections.detail.remoteDestination') },
      { key: 'dnsMode', label: t('connections.detail.dnsMode') }
    ],
    [t]
  )

  // Build process groups from connections
  const processGroups = useMemo(() => {
    const groupMap = new Map<
      string,
      {
        processPath: string
        processName: string
        activeCount: number
        closedCount: number
        totalUpload: number
        totalDownload: number
        totalUploadSpeed: number
        totalDownloadSpeed: number
      }
    >()

    const addToGroup = (conn: ControllerConnectionDetail, isActive: boolean) => {
      const processPath = processKey(conn)
      const processName = conn.metadata.process || conn.metadata.sourceIP || ''
      const existing = groupMap.get(processPath)
      if (existing) {
        if (isActive) {
          existing.activeCount++
          existing.totalUploadSpeed += conn.uploadSpeed || 0
          existing.totalDownloadSpeed += conn.downloadSpeed || 0
        } else {
          existing.closedCount++
        }
        existing.totalUpload += conn.upload
        existing.totalDownload += conn.download
      } else {
        groupMap.set(processPath, {
          processPath,
          processName,
          activeCount: isActive ? 1 : 0,
          closedCount: isActive ? 0 : 1,
          totalUpload: conn.upload,
          totalDownload: conn.download,
          totalUploadSpeed: isActive ? conn.uploadSpeed || 0 : 0,
          totalDownloadSpeed: isActive ? conn.downloadSpeed || 0 : 0
        })
      }
    }

    activeConnections.forEach((conn) => addToGroup(conn, true))
    closedConnections.forEach((conn) => addToGroup(conn, false))

    const groups: ProcessGroup[] = Array.from(groupMap.values())

    groups.sort((a, b) => {
      if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount
      return b.totalUpload + b.totalDownload - (a.totalUpload + a.totalDownload)
    })

    return groups
  }, [activeConnections, closedConnections])

  const filteredProcessGroups = useMemo(() => {
    if (filter === '') return processGroups
    const matchingProcessPaths = new Set<string>()
    for (const connection of [...activeConnections, ...closedConnections]) {
      const path = processKey(connection)
      if (
        matchesConnectionQuery(
          connection,
          filter,
          displayAppName ? appNames[connection.metadata.processPath || ''] : undefined
        )
      ) {
        matchingProcessPaths.add(path)
      }
    }
    return processGroups.filter((pg) => {
      const name = displayAppName && pg.processPath ? appNames[pg.processPath] : undefined
      const searchable = [pg.processName, name, pg.processPath].filter(Boolean).join(' ')
      return includesIgnoreCase(searchable, filter) || matchingProcessPaths.has(pg.processPath)
    })
  }, [processGroups, filter, displayAppName, appNames, activeConnections, closedConnections])

  const filteredConnections = useMemo(() => {
    const connections = tab === 'active' ? activeConnections : closedConnections

    let filtered = connections

    // When a process is selected, filter by process
    if (selectedProcess !== null) {
      filtered = filtered.filter((conn) => {
        return processKey(conn) === selectedProcess
      })
    }

    if (filter !== '') {
      filtered = filtered.filter((connection) => {
        return matchesConnectionQuery(
          connection,
          filter,
          displayAppName ? appNames[connection.metadata.processPath || ''] : undefined
        )
      })
    }

    if (outboundFilter !== 'all') {
      filtered = filtered.filter((connection) => {
        const direct = connection.chains.includes('DIRECT')
        return outboundFilter === 'direct' ? direct : !direct
      })
    }

    if (connectionOrderBy) {
      filtered = [...filtered].sort((a, b) => {
        if (connectionDirection === 'asc') {
          switch (connectionOrderBy) {
            case 'time':
              return dayjs(b.start).unix() - dayjs(a.start).unix()
            case 'upload':
              return a.upload - b.upload
            case 'download':
              return a.download - b.download
            case 'uploadSpeed':
              return (a.uploadSpeed || 0) - (b.uploadSpeed || 0)
            case 'downloadSpeed':
              return (a.downloadSpeed || 0) - (b.downloadSpeed || 0)
            case 'process':
              return (a.metadata.process || '').localeCompare(b.metadata.process || '')
          }
        } else {
          switch (connectionOrderBy) {
            case 'time':
              return dayjs(a.start).unix() - dayjs(b.start).unix()
            case 'upload':
              return b.upload - a.upload
            case 'download':
              return b.download - a.download
            case 'uploadSpeed':
              return (b.uploadSpeed || 0) - (a.uploadSpeed || 0)
            case 'downloadSpeed':
              return (b.downloadSpeed || 0) - (a.downloadSpeed || 0)
            case 'process':
              return (b.metadata.process || '').localeCompare(a.metadata.process || '')
          }
        }
      })
    }

    return filtered
  }, [
    activeConnections,
    closedConnections,
    filter,
    outboundFilter,
    connectionDirection,
    connectionOrderBy,
    tab,
    selectedProcess,
    displayAppName,
    appNames
  ])

  const selectedConnection =
    filteredConnections.find((connection) => connection.id === selectedId) ?? filteredConnections[0]

  const handleSelectConnection = useCallback((connection: ControllerConnectionDetail) => {
    setSelectedId(connection.id)
  }, [])

  const handleOpenDetails = useCallback((connection: ControllerConnectionDetail) => {
    setSelected(connection)
    setIsDetailModalOpen(true)
  }, [])

  const closeAllConnections = useCallback((): void => {
    if (tab === 'active') {
      mihomoCloseAllConnections()
    } else {
      clearAllClosed()
    }
  }, [tab, clearAllClosed])

  const closeConnection = useCallback(
    (id: string): void => {
      if (tab === 'active') {
        mihomoCloseConnection(id)
      } else {
        removeClosedById(id)
      }
    },
    [tab, removeClosedById]
  )

  const handleColumnWidthChange = useCallback(
    async (widths: Record<string, number>) => {
      await patchAppConfig({ connectionTableColumnWidths: widths })
    },
    [patchAppConfig]
  )

  const handleSortChange = useCallback(
    async (column: string | null, direction: 'asc' | 'desc') => {
      await patchAppConfig({
        connectionTableSortColumn: column || undefined,
        connectionTableSortDirection: direction
      })
    },
    [patchAppConfig]
  )

  const handleOrderByChange = useCallback(
    async (value: string) => {
      await patchAppConfig({
        connectionOrderBy: value as
          | 'time'
          | 'upload'
          | 'download'
          | 'uploadSpeed'
          | 'downloadSpeed'
          | 'process'
      })
    },
    [patchAppConfig]
  )

  const handleDirectionToggle = useCallback(async () => {
    await patchAppConfig({
      connectionDirection: connectionDirection === 'asc' ? 'desc' : 'asc'
    })
  }, [connectionDirection, patchAppConfig])

  const handleVisibleColumnToggle = useCallback(
    (key: string, checked: boolean) => {
      setVisibleColumns((prev) => {
        const next = new Set(prev)
        if (checked) {
          next.add(key)
        } else {
          next.delete(key)
        }
        void patchAppConfig({ connectionTableColumns: Array.from(next) })
        return next
      })
    },
    [patchAppConfig]
  )

  const handleProcessClick = useCallback((processPath: string) => {
    setSelectedProcess(processPath)
  }, [])

  const handleBackToProcesses = useCallback(() => {
    setSelectedProcess(null)
  }, [])

  const selectedProcessAppName = useProcessAppName(
    selectedProcess || '',
    displayAppName && selectedProcess !== null
  )

  const selectedProcessName = useMemo(() => {
    if (selectedProcess === null) return ''
    if (selectedProcessAppName) return selectedProcessAppName
    const group = processGroups.find((g) => g.processPath === selectedProcess)
    if (!group) return selectedProcess
    return group.processName || t('pages.connections.unknownProcess')
  }, [selectedProcess, selectedProcessAppName, processGroups, t])

  const matchesSelectedProcess = useCallback(
    (conn: ControllerConnectionDetail) => {
      const connProcessPath =
        conn.metadata.processPath || conn.metadata.process || conn.metadata.sourceIP || ''
      return connProcessPath === selectedProcess
    },
    [selectedProcess]
  )

  const processClosedCount = useMemo(() => {
    if (selectedProcess === null) return 0
    return closedConnections.filter(matchesSelectedProcess).length
  }, [closedConnections, selectedProcess, matchesSelectedProcess])

  const iconEnabled = displayIcon && findProcessMode !== 'off'

  // Whether we are in the process list view (level 1) or connections view (level 2)
  // In classic mode, we never show the process list
  const isClassicMode = connectionListMode === 'classic'
  const isProcessListView = !isClassicMode && selectedProcess === null
  // Inside a process drill-down every row belongs to the same app, so the row
  // drops the icon and the "process →" prefix; the app is identified in the header instead.
  const isProcessDetailView = !isClassicMode && selectedProcess !== null

  const selectedProcessIcon = useProcessIcon(
    selectedProcess || '',
    iconEnabled && isProcessDetailView
  )

  const renderConnectionItem = useCallback(
    (_i: number, connection: ControllerConnectionDetail) => {
      return (
        <ConnectionItem
          displayIcon={iconEnabled && !isProcessDetailView}
          displayAppName={displayAppName}
          showProcess={!isProcessDetailView}
          selected={connection.id === selectedConnection?.id}
          onSelect={handleSelectConnection}
          key={connection.id}
          info={connection}
        />
      )
    },
    [
      displayAppName,
      iconEnabled,
      isProcessDetailView,
      selectedConnection?.id,
      handleSelectConnection
    ]
  )

  const renderProcessItem = useCallback(
    (_i: number, process: ProcessGroup) => {
      return (
        <ProcessItem
          key={process.processPath}
          process={process}
          displayIcon={iconEnabled}
          displayAppName={displayAppName}
          onClick={handleProcessClick}
        />
      )
    },
    [iconEnabled, displayAppName, handleProcessClick]
  )

  const handleClearFilter = useCallback(() => setFilter(''), [])

  const availableClosedCount = isClassicMode ? closedConnections.length : processClosedCount

  const filterEmptyState = (
    <ConnectionsEmpty
      icon={SearchX}
      title={t('pages.connections.emptyFilterTitle')}
      description={t('pages.connections.emptyFilterDescription')}
      action={{ label: t('pages.connections.clearFilter'), onClick: handleClearFilter }}
    />
  )

  const processesEmptyState =
    filter !== '' ? (
      filterEmptyState
    ) : (
      <ConnectionsEmpty
        icon={AppWindow}
        title={t('pages.connections.emptyProcessesTitle')}
        description={t('pages.connections.emptyProcessesDescription')}
      />
    )

  const connectionsEmptyState =
    filter !== '' ? (
      filterEmptyState
    ) : tab === 'active' ? (
      <ConnectionsEmpty
        icon={Unplug}
        title={t('pages.connections.emptyActiveTitle')}
        description={t('pages.connections.emptyActiveDescription')}
        // Opening an app that only has history lands on an empty "active" tab —
        // offer the way out instead of leaving a dead end.
        action={
          availableClosedCount > 0
            ? { label: t('pages.connections.showClosed'), onClick: () => setTab('closed') }
            : undefined
        }
      />
    ) : (
      <ConnectionsEmpty
        icon={History}
        title={t('pages.connections.emptyClosedTitle')}
        description={t('pages.connections.emptyClosedDescription')}
      />
    )

  const title = isProcessDetailView ? (
    <div className="flex min-w-0 items-center gap-2">
      {iconEnabled &&
        (selectedProcessIcon ? (
          <img src={selectedProcessIcon} alt="" className="size-6 shrink-0 rounded-md" />
        ) : (
          <div className="size-6 shrink-0 rounded-md bg-muted flex items-center justify-center">
            <span className="text-[10px] font-semibold leading-none text-muted-foreground">
              {selectedProcessName.slice(0, 2).toUpperCase()}
            </span>
          </div>
        ))}
      <span className="truncate max-w-[38vw]" title={selectedProcessName}>
        {selectedProcessName}
      </span>
    </div>
  ) : (
    t('pages.connections.title')
  )

  const [downloadAmount, downloadUnit] = calcTraffic(info.downloadTotal).split(' ')
  const [uploadAmount, uploadUnit] = calcTraffic(info.uploadTotal).split(' ')

  return (
    <BasePage
      title={title}
      subtitle={t('redesign.connectionsSubtitle')}
      contentClassName="koala-connections-page"
      header={
        <div className="koala-connection-header-actions">
          <Button variant="outline" size="sm" onClick={togglePause}>
            {isPaused ? <Play className="size-4" /> : <Pause className="size-4" />}
            {t(isPaused ? 'redesign.resumeRefresh' : 'redesign.pauseRefresh')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={t('redesign.moreActions')}
                title={t('redesign.moreActions')}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="koala-connection-more-menu">
              <DropdownMenuLabel>{t('redesign.moreActions')}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setTab('active')}>
                {t('pages.connections.active')}
                {tab === 'active' && <span className="ml-auto">✓</span>}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTab('closed')}>
                {t('pages.connections.closed')} · {closedConnections.length}
                {tab === 'closed' && <span className="ml-auto">✓</span>}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  const nextMode = viewMode === 'list' ? 'table' : 'list'
                  setViewMode(nextMode)
                  void patchAppConfig({ connectionViewMode: nextMode })
                }}
              >
                {viewMode === 'list' ? (
                  <Table2 className="size-4" />
                ) : (
                  <TableOfContents className="size-4" />
                )}
                {t(
                  viewMode === 'list'
                    ? 'pages.connections.switchToTable'
                    : 'pages.connections.switchToList'
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setSelectedProcess(null)
                  setOutboundFilter('all')
                  void patchAppConfig({
                    connectionListMode: isClassicMode ? 'process' : 'classic'
                  })
                }}
              >
                {t(
                  isClassicMode ? 'pages.connections.processView' : 'pages.connections.classicView'
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setIsSettingModalOpen(true)}>
                <SlidersHorizontal className="size-4" />
                {t('pages.connections.connectionSettings')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!selectedConnection}
                onSelect={() => {
                  if (selectedConnection) handleOpenDetails(selectedConnection)
                }}
              >
                {t('redesign.details')}
              </DropdownMenuItem>
              {!isProcessListView && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      if (
                        filter === '' &&
                        outboundFilter === 'all' &&
                        (isClassicMode || selectedProcess === null)
                      ) {
                        closeAllConnections()
                      } else {
                        filteredConnections.forEach((connection) => closeConnection(connection.id))
                      }
                    }}
                  >
                    {t(
                      tab === 'active'
                        ? 'pages.connections.closeAll'
                        : 'pages.connections.clearClosed'
                    )}
                  </DropdownMenuItem>
                </>
              )}
              {viewMode === 'list' && !isProcessListView && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t('pages.connections.sortDirection')}</DropdownMenuLabel>
                  {(
                    [
                      'time',
                      'upload',
                      'download',
                      'uploadSpeed',
                      'downloadSpeed',
                      'process'
                    ] as const
                  ).map((order) => (
                    <DropdownMenuItem key={order} onSelect={() => void handleOrderByChange(order)}>
                      {t(
                        order === 'process'
                          ? 'pages.connections.processName'
                          : order === 'time'
                            ? 'pages.connections.time'
                            : order === 'upload'
                              ? 'pages.connections.uploadAmount'
                              : order === 'download'
                                ? 'pages.connections.downloadAmount'
                                : order === 'uploadSpeed'
                                  ? 'pages.connections.uploadSpeed'
                                  : 'pages.connections.downloadSpeed'
                      )}
                      {connectionOrderBy === order && <span className="ml-auto">✓</span>}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onSelect={() => void handleDirectionToggle()}>
                    {connectionDirection === 'asc' ? (
                      <ArrowDownNarrowWide className="size-4" />
                    ) : (
                      <ArrowDownWideNarrow className="size-4" />
                    )}
                    {t('pages.connections.sortDirection')}
                  </DropdownMenuItem>
                </>
              )}
              {viewMode === 'table' && !isProcessListView && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t('pages.connections.tableColumns')}</DropdownMenuLabel>
                  {columnOptions.map((option) => (
                    <DropdownMenuCheckboxItem
                      key={option.key}
                      checked={visibleColumns.has(option.key)}
                      onCheckedChange={(checked) => handleVisibleColumnToggle(option.key, checked)}
                    >
                      {option.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      {isDetailModalOpen && selected && (
        <ConnectionDetailModal onClose={() => setIsDetailModalOpen(false)} connection={selected} />
      )}
      {isSettingModalOpen && (
        <ConnectionSettingModal onClose={() => setIsSettingModalOpen(false)} />
      )}

      <div className="koala-connection-stats">
        <div>
          <div className="koala-connection-stat-label">{t('redesign.activeConnections')}</div>
          <div className="koala-connection-stat-value">{activeConnections.length}</div>
        </div>
        <div>
          <div className="koala-connection-stat-label">{t('redesign.downloadTotal')}</div>
          <div className="koala-connection-stat-value">
            {downloadAmount}
            <small>{downloadUnit}</small>
          </div>
        </div>
        <div>
          <div className="koala-connection-stat-label">{t('redesign.uploadTotal')}</div>
          <div className="koala-connection-stat-value">
            {uploadAmount}
            <small>{uploadUnit}</small>
          </div>
        </div>
      </div>

      <div className="koala-connection-filter-row">
        {isProcessDetailView && (
          <Button variant="ghost" size="sm" onClick={handleBackToProcesses}>
            <ArrowLeft className="size-4" />
            {t('pages.connections.backToProcesses')}
          </Button>
        )}
        <label className="koala-connection-search">
          <Search className="size-4" aria-hidden />
          <input
            type="search"
            value={filter}
            placeholder={t('redesign.searchAppsDomains')}
            aria-label={t('redesign.searchAppsDomains')}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        {!isProcessListView && (
          <select
            className="koala-connection-outbound-filter"
            value={outboundFilter}
            aria-label={t('redesign.allOutbound')}
            onChange={(event) =>
              setOutboundFilter(event.target.value as 'all' | 'proxy' | 'direct')
            }
          >
            <option value="all">{t('redesign.allOutbound')}</option>
            <option value="proxy">{t('redesign.proxyOutbound')}</option>
            <option value="direct">{t('redesign.directOutbound')}</option>
          </select>
        )}
      </div>

      {isPaused && <p className="koala-connection-pause-note">{t('redesign.refreshPaused')}</p>}
      {tab === 'closed' && !isProcessListView && (
        <p className="koala-connection-context">
          {t('pages.connections.closed')} · {closedConnections.length}
        </p>
      )}

      <div className="koala-connection-master-detail" data-process-list={isProcessListView}>
        <div className="koala-connection-list">
          {(isProcessListView || viewMode === 'list') && (
            <div className="koala-connection-list-head">
              <span>
                {isProcessListView
                  ? t('pages.connections.processes')
                  : t('redesign.applicationTarget')}
              </span>
              <span>
                {t(isProcessListView ? 'pages.connections.title' : 'redesign.outboundColumn')}
              </span>
              <span>{t('pages.connections.downloadAmount')}</span>
            </div>
          )}
          <div className="koala-connection-list-body">
            {isProcessListView ? (
              filteredProcessGroups.length === 0 ? (
                processesEmptyState
              ) : (
                <Virtuoso
                  style={{ height: '100%' }}
                  data={filteredProcessGroups}
                  itemContent={renderProcessItem}
                />
              )
            ) : viewMode === 'list' ? (
              filteredConnections.length === 0 ? (
                connectionsEmptyState
              ) : (
                <Virtuoso
                  style={{ height: '100%' }}
                  data={filteredConnections}
                  itemContent={renderConnectionItem}
                />
              )
            ) : (
              <ConnectionTable
                emptyState={connectionsEmptyState}
                connections={filteredConnections}
                selectedId={selectedConnection?.id}
                onSelect={handleSelectConnection}
                onOpenDetails={handleOpenDetails}
                close={closeConnection}
                visibleColumns={visibleColumns}
                initialColumnWidths={connectionTableColumnWidths}
                initialSortColumn={connectionTableSortColumn}
                initialSortDirection={connectionTableSortDirection}
                onColumnWidthChange={handleColumnWidthChange}
                onSortChange={handleSortChange}
              />
            )}
          </div>
        </div>
        {!isProcessListView && (
          <ConnectionInspector connection={selectedConnection} onClose={closeConnection} />
        )}
      </div>
    </BasePage>
  )
}

export default Connections
