import { useProcessAppName, useProcessIcon } from '@renderer/store/icons-store'
import { calcTraffic } from '@renderer/utils/calc'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'

export interface ProcessGroup {
  processPath: string
  processName: string
  activeCount: number
  closedCount: number
  totalUpload: number
  totalDownload: number
  totalUploadSpeed: number
  totalDownloadSpeed: number
}

interface Props {
  process: ProcessGroup
  displayIcon: boolean
  displayAppName: boolean
  onClick: (processPath: string) => void
}

function ProcessItemComponent({ process, displayIcon, displayAppName, onClick }: Props) {
  const { t } = useTranslation()
  const iconUrl = useProcessIcon(process.processPath, displayIcon)
  const appName = useProcessAppName(process.processPath, displayAppName)
  const name = appName || process.processName || t('pages.connections.unknownProcess')

  return (
    <button
      type="button"
      className="koala-process-row"
      onClick={() => onClick(process.processPath)}
      aria-label={name}
    >
      <span className="flex min-w-0 items-center gap-2">
        {displayIcon && iconUrl && <img src={iconUrl} alt="" className="size-5 shrink-0 rounded" />}
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium" title={name}>
            {name}
          </span>
          <span
            className="block truncate text-[10px] text-muted-foreground"
            title={process.processPath}
          >
            {process.processPath || t('pages.connections.unknownProcess')}
          </span>
        </span>
      </span>
      <span className="text-center font-mono text-[11px] tabular-nums">
        {process.activeCount}
        {process.closedCount > 0 && (
          <span className="ml-1 text-muted-foreground">/ {process.closedCount}</span>
        )}
      </span>
      <span
        className="truncate text-right font-mono text-[11px] tabular-nums"
        title={calcTraffic(process.totalDownload)}
      >
        {calcTraffic(process.totalDownload)}
      </span>
    </button>
  )
}

export default memo(ProcessItemComponent)
