import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Input } from '@renderer/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import React, { useState, useEffect } from 'react'
import SettingItem from '../base/base-setting-item'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import debounce from '@renderer/utils/debounce'
import { t } from 'i18next'

interface Props {
  onClose: () => void
}

const ProxySettingModal: React.FC<Props> = (props) => {
  const { onClose } = props
  const { appConfig, patchAppConfig } = useAppConfig()

  const {
    proxyDisplayOrder = 'default',
    autoCloseConnection = true,
    delayTestUrl,
    delayTestConcurrency,
    delayTestTimeout
  } = appConfig || {}

  const [url, setUrl] = useState(delayTestUrl ?? '')

  const setUrlDebounce = debounce((v: string) => {
    patchAppConfig({ delayTestUrl: v })
  }, 500)

  useEffect(() => {
    setUrl(delayTestUrl ?? '')
  }, [delayTestUrl])

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="flag-emoji sm:max-w-xl max-h-[calc(100vh-120px)] flex flex-col min-h-0"
        showCloseButton={false}
      >
        <DialogHeader className="pb-0">
          <DialogTitle>{t('pages.proxies.proxyGroupSettings')}</DialogTitle>
        </DialogHeader>
        <div className="py-2 flex flex-col gap-1 overflow-y-auto min-h-0">
          <SettingItem title={t('proxies.nodeSortMethod')} divider>
            <Tabs
              value={proxyDisplayOrder}
              onValueChange={async (value) => {
                await patchAppConfig({
                  proxyDisplayOrder: value as 'default' | 'delay' | 'name'
                })
              }}
            >
              <TabsList>
                <TabsTrigger value="default">{t('proxies.sortDefault')}</TabsTrigger>
                <TabsTrigger value="delay">{t('proxies.sortDelay')}</TabsTrigger>
                <TabsTrigger value="name">{t('proxies.sortName')}</TabsTrigger>
              </TabsList>
            </Tabs>
          </SettingItem>
          <SettingItem title={t('proxies.disconnectOnSwitch')} divider>
            <Switch
              checked={autoCloseConnection}
              onCheckedChange={(value) => {
                patchAppConfig({ autoCloseConnection: value })
              }}
            />
          </SettingItem>
          <SettingItem title={t('proxies.delayTestUrl')} divider>
            <Input
              className="w-[60%] h-8"
              value={url}
              placeholder={t('proxies.delayTestUrlPlaceholder')}
              onChange={(event) => {
                const value = event.target.value
                setUrl(value)
                setUrlDebounce(value)
              }}
            />
          </SettingItem>
          <SettingItem title={t('proxies.delayTestConcurrency')} divider>
            <Input
              type="number"
              className="w-[100px] h-8"
              value={delayTestConcurrency?.toString() ?? ''}
              placeholder={t('proxies.delayTestConcurrencyPlaceholder')}
              onChange={(event) => {
                patchAppConfig({ delayTestConcurrency: parseInt(event.target.value) })
              }}
            />
          </SettingItem>
          <SettingItem title={t('proxies.delayTestTimeout')}>
            <Input
              type="number"
              className="w-[100px] h-8"
              value={delayTestTimeout?.toString() ?? ''}
              placeholder={t('proxies.delayTestTimeoutPlaceholder')}
              onChange={(event) => {
                patchAppConfig({ delayTestTimeout: parseInt(event.target.value) })
              }}
            />
          </SettingItem>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button size="sm" variant="ghost">
              {t('common.close')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ProxySettingModal
