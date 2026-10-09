import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import ConfirmModal from '@renderer/components/base/base-confirm'
import { useProxyControl } from '@renderer/hooks/use-proxy-control'
import type { ProxyMode } from '@renderer/utils/proxy-control'

export default function ProxyModeTabs({
  confirmWhenConnected = true,
  disabled = false
}: {
  confirmWhenConnected?: boolean
  disabled?: boolean
}) {
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
          if (next === mode || busy || !ready || disabled) return
          if (enabled && confirmWhenConnected) setPending(next)
          else void apply(next, enabled ? true : undefined)
        }}
      >
        <TabsList
          className="ui-mode-tabs w-full"
          aria-label={t('redesign.proxyMode')}
          aria-busy={busy}
        >
          <TabsTrigger disabled={busy || !ready || disabled} className="flex-1" value="sysproxy">
            {t('redesign.systemProxyShort')}
          </TabsTrigger>
          <TabsTrigger disabled={busy || !ready || disabled} className="flex-1" value="tun">
            {t('redesign.tunModeShort')}
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
