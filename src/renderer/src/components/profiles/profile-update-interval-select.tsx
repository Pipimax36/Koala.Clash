import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'

const intervalHours = [12, 24, 48, 72] as const

interface Props {
  value?: number
  enabled?: boolean
  locked?: boolean
  onChange: (minutes: number | null) => void
  disabled?: boolean
  id?: string
  className?: string
}

export default function ProfileUpdateIntervalSelect({
  value,
  enabled = true,
  locked = false,
  onChange,
  disabled,
  id,
  className
}: Props): JSX.Element {
  const { t } = useTranslation()
  const storedValue = value === undefined ? '' : String(value)
  const selectedValue = enabled ? storedValue : 'off'
  const isPreset = intervalHours.some((hours) => hours * 60 === value)
  const hasCurrentInterval = value !== undefined && Number.isFinite(value) && value > 0
  const currentLabel = hasCurrentInterval
    ? value % 60 === 0
      ? t('profile.updateIntervalHours', { count: value / 60 })
      : t('profile.updateIntervalMinutesValue', { count: value })
    : t('profile.updateIntervalUnset')

  return (
    <select
      id={id}
      name="updateInterval"
      aria-label={t('profile.updateInterval')}
      className={cn(
        'h-8 min-w-28 rounded-md border border-input bg-card px-2.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      value={selectedValue}
      disabled={disabled}
      onChange={(event) => {
        if (event.target.value === 'off') {
          onChange(null)
          return
        }
        const minutes = Number(event.target.value)
        const isCurrentInterval = hasCurrentInterval && minutes === value
        if (locked && !isCurrentInterval) return
        if (isCurrentInterval || intervalHours.some((hours) => hours * 60 === minutes)) {
          onChange(minutes)
        }
      }}
    >
      <option value="off">{t('profile.noAutoUpdate')}</option>
      {!isPreset && (
        <option value={storedValue} disabled={!hasCurrentInterval}>
          {currentLabel}
        </option>
      )}
      {intervalHours.map((hours) => (
        <option key={hours} value={hours * 60} disabled={locked && hours * 60 !== value}>
          {t('profile.updateIntervalHours', { count: hours })}
        </option>
      ))}
    </select>
  )
}
