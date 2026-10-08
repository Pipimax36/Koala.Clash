import { useRef, useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@renderer/components/ui/button'
import { useUpdaterStore } from '@renderer/store/updater-store'
import { cancelUpdate, checkUpdate } from '@renderer/utils/ipc'
import UpdaterModal from './updater-modal'

type Props = Pick<ComponentProps<typeof Button>, 'variant' | 'className'>

export default function CheckUpdateButton({ variant, className }: Props) {
  const { t } = useTranslation()
  const [latest, setLatest] = useState<AppVersion>()
  const [checking, setChecking] = useState(false)
  const pending = useRef(false)
  const updateStatus = useUpdaterStore(
    useShallow((state) => ({
      downloading: state.downloading,
      progress: state.progress,
      error: state.error
    }))
  )
  const resetUpdateStatus = useUpdaterStore((state) => state.reset)

  const check = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setChecking(true)
    try {
      const available = await checkUpdate()
      if (available) setLatest(available)
      else toast.success(t('settings.actions.noNeedUpdate'))
    } catch (error) {
      toast.error(String(error))
    } finally {
      pending.current = false
      setChecking(false)
    }
  }

  const cancel = async (): Promise<void> => {
    try {
      await cancelUpdate()
      resetUpdateStatus()
    } catch {
      // Keep the current download state when cancellation fails.
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant={variant}
        className={className}
        disabled={checking}
        aria-busy={checking}
        onClick={() => void check()}
      >
        {checking && <LoaderCircle className="animate-spin" aria-hidden />}
        {t('settings.actions.checkUpdate')}
      </Button>
      {latest && (
        <UpdaterModal
          version={latest.version}
          changelog={latest.changelog}
          updateStatus={updateStatus}
          onCancel={() => void cancel()}
          onClose={() => setLatest(undefined)}
        />
      )}
    </>
  )
}
