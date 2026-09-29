import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTrafficStore } from '@renderer/store/traffic-store'
import { calcTraffic } from '@renderer/utils/calc'

type Sample = Pick<ControllerTraffic, 'up' | 'down'>

export default function TrafficHistory({ available }: { available: boolean }) {
  const { t } = useTranslation()
  const [samples, setSamples] = useState<Sample[]>([])

  useEffect(() => {
    setSamples([])
    if (!available) return undefined
    const interval = setInterval(() => {
      const { up, down } = useTrafficStore.getState().traffic
      setSamples((previous) => [...previous.slice(-59), { up, down }])
    }, 1000)
    return () => clearInterval(interval)
  }, [available])

  const peak = Math.max(1, ...samples.flatMap((sample) => [sample.up, sample.down]))
  const line = (key: keyof Sample): string =>
    samples
      .map((sample, index) => {
        const x = ((60 - samples.length + index) / 59) * 400
        const y = 92 - (Math.max(0, sample[key]) / peak) * 84
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

  return (
    <div aria-label={t('redesign.trafficHistory')}>
      <svg
        className="ui-traffic-chart"
        viewBox="0 0 400 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={t('redesign.trafficHistory')}
      >
        <path d="M0 18H400 M0 55H400 M0 92H400" stroke="var(--border)" fill="none" />
        {samples.length > 1 && (
          <>
            <path
              d={`${line('down')} L400 100 L${((60 - samples.length) / 59) * 400} 100 Z`}
              fill="var(--success-tint)"
            />
            <path
              d={line('down')}
              stroke="var(--success)"
              strokeWidth="1.8"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={line('up')}
              stroke="var(--chart-upload)"
              strokeWidth="1.4"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      <div className="ui-chart-axis">
        <span>{t('redesign.minuteAgo')}</span>
        <span>
          {!available
            ? t('redesign.coreUnavailable')
            : samples.length < 2
              ? t('redesign.collectingTraffic')
              : `${t('redesign.recentMinute')} · ${calcTraffic(peak).split(' ')[1]}/s`}
        </span>
        <span>{t('redesign.now')}</span>
      </div>
    </div>
  )
}
