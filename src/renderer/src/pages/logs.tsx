import BasePage from '@renderer/components/base/base-page'
import LogItem from '@renderer/components/logs/log-item'
import { Button } from '@renderer/components/ui/button'
import { useLogsStore } from '@renderer/store/logs-store'
import { includesIgnoreCase } from '@renderer/utils/includes'
import { Pause, Play, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import '@renderer/components/logs/logs-page.css'

const Logs: React.FC = () => {
  const { t } = useTranslation()
  const clearLogs = useLogsStore((s) => s.clear)
  const [logs, setLogs] = useState<ControllerLog[]>(() => useLogsStore.getState().logs)
  const [filter, setFilter] = useState('')
  const [level, setLevel] = useState('all')
  const [trace, setTrace] = useState(true)
  const traceRef = useRef(trace)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const isInitialRef = useRef(true)

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      return (
        (level === 'all' || log.type === level) &&
        (includesIgnoreCase(log.payload, filter) ||
          includesIgnoreCase(log.type, filter) ||
          includesIgnoreCase(log.time, filter))
      )
    })
  }, [logs, filter, level])

  const toggleTrace = useCallback(() => {
    setTrace((prev) => {
      const next = !prev
      traceRef.current = next
      if (next) setLogs([...useLogsStore.getState().logs])
      return next
    })
  }, [])

  useEffect(() => {
    if (!trace || !filteredLogs.length) return
    virtuosoRef.current?.scrollToIndex({
      index: filteredLogs.length - 1,
      behavior: isInitialRef.current ? 'auto' : 'smooth',
      align: 'end',
      offset: 0
    })
    isInitialRef.current = false
  }, [filteredLogs, trace])

  useEffect(() => {
    return useLogsStore.subscribe((state) => {
      if (traceRef.current) setLogs([...state.logs])
    })
  }, [])

  return (
    <BasePage
      title={t('sider.logs')}
      subtitle={t('redesign.logsSubtitle')}
      contentClassName="koala-logs-page"
      header={
        <div className="koala-log-actions">
          <Button size="sm" variant="outline" onClick={toggleTrace}>
            {trace ? <Pause className="size-4" /> : <Play className="size-4" />}
            {t(trace ? 'redesign.pauseLogs' : 'redesign.resumeLogs')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              clearLogs()
              setLogs([])
            }}
          >
            <Trash2 className="size-4" />
            {t('pages.logs.clearLogs')}
          </Button>
        </div>
      }
    >
      <div className="koala-log-filter-row">
        <label className="koala-log-search">
          <Search className="size-4" aria-hidden />
          <input
            type="search"
            value={filter}
            aria-label={t('redesign.searchLogs')}
            placeholder={t('redesign.searchLogs')}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <select
          className="koala-log-level-filter"
          value={level}
          aria-label={t('redesign.allLevels')}
          onChange={(event) => setLevel(event.target.value)}
        >
          <option value="all">{t('redesign.allLevels')}</option>
          <option value="info">Info</option>
          <option value="warning">Warn</option>
          <option value="error">Error</option>
          <option value="debug">Debug</option>
          <option value="silent">Silent</option>
        </select>
      </div>

      <div className="koala-log-console">
        <div className="koala-log-head">
          <span className="koala-log-status">
            <span className="koala-log-dot" data-paused={!trace} />
            {t(trace ? 'redesign.logsRunning' : 'redesign.logsPausedShort')}
          </span>
          <span className="tabular-nums">
            {t('redesign.logCount', { count: filteredLogs.length })}
          </span>
        </div>
        <div className="koala-log-list">
          {filteredLogs.length ? (
            <Virtuoso
              style={{ height: '100%' }}
              ref={virtuosoRef}
              data={filteredLogs}
              initialItemCount={Math.min(filteredLogs.length, 15)}
              followOutput={trace}
              itemContent={(i, log) => (
                <LogItem
                  index={i}
                  key={log.payload + i}
                  time={log.time}
                  type={log.type}
                  payload={log.payload}
                />
              )}
            />
          ) : (
            <div className="koala-log-empty">
              {t(filter || level !== 'all' ? 'redesign.noResults' : 'redesign.noLogs')}
            </div>
          )}
        </div>
      </div>
    </BasePage>
  )
}

export default Logs
