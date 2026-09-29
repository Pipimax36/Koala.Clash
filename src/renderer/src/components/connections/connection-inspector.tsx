import { Button } from '@renderer/components/ui/button'
import { calcTraffic } from '@renderer/utils/calc'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  connection?: ControllerConnectionDetail
  onClose: (id: string) => void
}

export default function ConnectionInspector({ connection, onClose }: Props) {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!connection?.isActive) return undefined
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [connection?.isActive])

  if (!connection) {
    return (
      <aside className="koala-connection-inspector">
        <h2>{t('connection.connectionDetails')}</h2>
        <p className="koala-connection-inspector-empty">
          {t('pages.connections.emptyActiveTitle')}
        </p>
      </aside>
    )
  }

  const destination =
    connection.metadata.host ||
    connection.metadata.sniffHost ||
    connection.metadata.destinationIP ||
    connection.metadata.remoteDestination ||
    '—'
  const process = connection.metadata.process || connection.metadata.sourceIP || '—'
  const chain = [...connection.chains].reverse().join(' → ') || '—'
  const start = dayjs(connection.start)
  const elapsed =
    connection.isActive && start.isValid()
      ? Math.max(0, Math.floor((now - start.valueOf()) / 1000))
      : null
  const duration =
    elapsed === null
      ? '—'
      : [Math.floor(elapsed / 3600), Math.floor((elapsed % 3600) / 60), elapsed % 60]
          .map((value) => String(value).padStart(2, '0'))
          .join(':')

  return (
    <aside className="koala-connection-inspector">
      <h2 title={process}>{process}</h2>
      <p className="koala-connection-inspector-destination" title={destination}>
        {destination}
      </p>
      <div className="koala-connection-path" aria-label={t('connections.detail.proxyChain')}>
        <div title={connection.metadata.network}>
          {process} · {connection.metadata.network.toUpperCase()} :
          {connection.metadata.destinationPort}
        </div>
        <div title={connection.rulePayload || connection.rule}>
          {t('connection.rule')} · {connection.rulePayload || connection.rule || '—'}
        </div>
        <div title={chain}>{chain}</div>
      </div>
      <dl className="koala-connection-inspector-stats">
        <div>
          <dt>{t('redesign.duration')}</dt>
          <dd>{duration}</dd>
        </div>
        <div>
          <dt>{t('pages.connections.uploadAmount')}</dt>
          <dd>{calcTraffic(connection.upload)}</dd>
        </div>
        <div>
          <dt>{t('pages.connections.downloadAmount')}</dt>
          <dd>{calcTraffic(connection.download)}</dd>
        </div>
      </dl>
      <Button
        className="koala-connection-close"
        variant="outline"
        size="sm"
        onClick={() => onClose(connection.id)}
      >
        {t(connection.isActive ? 'redesign.disconnect' : 'common.delete')}
      </Button>
    </aside>
  )
}
