import React from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@renderer/components/ui/spinner'

interface Props {
  proxy: ControllerProxiesDetail | ControllerGroupDetail
  selected: boolean
  inspected: boolean
  onInspect: () => void
  isGroupDelaying?: boolean
  last?: boolean
}

const ProxyItem: React.FC<Props> = React.memo(
  ({ proxy, selected, inspected, onInspect, isGroupDelaying, last }) => {
    const { t } = useTranslation()
    const delay = proxy.history.at(-1)?.delay
    const description = 'serverDescription' in proxy ? proxy.serverDescription : undefined

    return (
      <button
        type="button"
        className="koala-node-row"
        aria-pressed={inspected}
        data-current={selected}
        data-last={last}
        onClick={onInspect}
      >
        <span className="koala-node-country" aria-hidden="true">
          {proxy.name.match(/\p{Regional_Indicator}{2}/u)?.[0] ||
            proxy.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="koala-node-row-label">
          <span className="koala-node-row-name" title={proxy.name}>
            {proxy.name}
          </span>
          <span className="koala-node-row-type">
            {proxy.type}
            {description ? ` · ${description}` : ''}
            {selected ? ` · ${t('redesign.usingNode')}` : ''}
          </span>
        </span>
        <span className="koala-node-row-status">
          {isGroupDelaying ? (
            <Spinner className="size-3" aria-label={t('redesign.testLatency')} />
          ) : delay === undefined ? (
            t('redesign.notTested')
          ) : delay === 0 ? (
            t('redesign.latencyTimeout')
          ) : (
            <>
              {delay} <small>ms</small>
            </>
          )}
        </span>
      </button>
    )
  }
)

ProxyItem.displayName = 'ProxyItem'

export default ProxyItem
