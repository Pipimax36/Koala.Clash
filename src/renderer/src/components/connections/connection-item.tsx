import { useProcessAppName, useProcessIcon } from '@renderer/store/icons-store'
import { calcTraffic } from '@renderer/utils/calc'
import { memo } from 'react'

interface Props {
  info: ControllerConnectionDetail
  displayIcon: boolean
  displayAppName: boolean
  showProcess?: boolean
  selected: boolean
  onSelect: (connection: ControllerConnectionDetail) => void
}

function ConnectionItemComponent({
  info,
  displayIcon,
  displayAppName,
  showProcess = true,
  selected,
  onSelect
}: Props) {
  const path = info.metadata.processPath || ''
  const iconUrl = useProcessIcon(path, displayIcon && showProcess)
  const appName = useProcessAppName(path, displayAppName && showProcess)
  const process = appName || info.metadata.process || info.metadata.sourceIP || '—'
  const host =
    info.metadata.host ||
    info.metadata.sniffHost ||
    info.metadata.destinationIP ||
    info.metadata.remoteDestination ||
    '—'
  const destination = `${host}:${info.metadata.destinationPort}`
  const outbound = [...info.chains].reverse().join(' → ') || '—'

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${process} ${destination}`}
      onClick={() => onSelect(info)}
      className="koala-connection-row"
    >
      <span className="flex min-w-0 items-center gap-2">
        {displayIcon && showProcess && iconUrl && (
          <img src={iconUrl} alt="" className="size-5 shrink-0 rounded" />
        )}
        <span className="min-w-0">
          <span
            className="block truncate text-xs font-medium"
            title={showProcess ? process : destination}
          >
            {showProcess ? process : destination}
          </span>
          <span className="block truncate text-[10px] text-muted-foreground" title={destination}>
            {showProcess ? destination : info.metadata.network.toUpperCase()}
          </span>
        </span>
      </span>
      <span className="min-w-0 truncate text-center text-[11px]" title={outbound}>
        {outbound}
      </span>
      <span
        className="min-w-0 truncate text-right font-mono text-[11px] tabular-nums"
        title={calcTraffic(info.download)}
      >
        {calcTraffic(info.download)}
      </span>
    </button>
  )
}

export default memo(ConnectionItemComponent)
