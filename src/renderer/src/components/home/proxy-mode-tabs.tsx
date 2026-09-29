import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import ConfirmModal from '@renderer/components/base/base-confirm'
import { useProxyControl } from '@renderer/hooks/use-proxy-control'
import type { ProxyMode } from '@renderer/utils/proxy-control'

export default function ProxyModeTabs() {
  const { t } = useTranslation()
  const { mode, enabled, busy, ready, apply } = useProxyControl()
  const [pending, setPending] = useState<ProxyMode | null>(null)
  return (
    <>
      <Tabs
        value={mode}
        activationMode="manual"
        onValueChange={(value) => {
          const next = value as ProxyMode
          if (next === mode || busy) return
          if (enabled) setPending(next)
          else void apply(next)
        }}
      >
        <TabsList className="ui-mode-tabs w-full" aria-label={t('redesign.proxyMode')}>
          <TabsTrigger disabled={busy || !ready} className="flex-1" value="sysproxy">
            {t('redesign.defaultMode')}
          </TabsTrigger>
          <TabsTrigger disabled={busy || !ready} className="flex-1" value="tun">
            {t('redesign.tunMode')}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {pending && (
        <ConfirmModal
          title={t('redesign.switchMode')}
          description={t('redesign.switchModeHint')}
          onChange={(open) => {
            if (!open) setPending(null)
          }}
          onConfirm={async () => {
            const next = pending
            setPending(null)
            await apply(next, true)
          }}
        />
      )}
    </>
  )
}
