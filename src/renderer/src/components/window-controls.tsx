import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { platform } from '@renderer/utils/init'
import { useAppConfig } from '@renderer/hooks/use-app-config'

const WindowControls: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig } = useAppConfig()
  const { useWindowFrame = false } = appConfig || {}
  const [isMaximized, setIsMaximized] = useState(false)
  const [isFocused, setIsFocused] = useState(document.hasFocus())
  const isMac = platform === 'darwin'

  useEffect(() => {
    if (useWindowFrame) return

    window.electron.ipcRenderer.invoke('windowIsMaximized').then(setIsMaximized)

    const onMaximize = (): void => setIsMaximized(true)
    const onUnmaximize = (): void => setIsMaximized(false)

    window.electron.ipcRenderer.on('window-maximized', onMaximize)
    window.electron.ipcRenderer.on('window-unmaximized', onUnmaximize)

    const onFocus = (): void => setIsFocused(true)
    const onBlur = (): void => setIsFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)

    return () => {
      window.electron.ipcRenderer.removeAllListeners('window-maximized')
      window.electron.ipcRenderer.removeAllListeners('window-unmaximized')
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [useWindowFrame])

  if (useWindowFrame) return null

  const handleMinimize = (): void => {
    window.electron.ipcRenderer.invoke('windowMinimize')
  }
  const handleMaximize = (): void => {
    window.electron.ipcRenderer.invoke('windowMaximize')
  }
  const handleClose = (): void => {
    window.electron.ipcRenderer.invoke('windowClose')
  }

  const closeBtn = (
    <button
      key="close"
      type="button"
      className="wc-btn wc-close"
      aria-label={t('common.windowClose')}
      title={t('common.windowClose')}
      onClick={handleClose}
    >
      <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path
          d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )

  const minimizeBtn = (
    <button
      key="minimize"
      type="button"
      className="wc-btn wc-minimize"
      aria-label={t('common.windowMinimize')}
      title={t('common.windowMinimize')}
      onClick={handleMinimize}
    >
      <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M1.5 5H8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </button>
  )

  const maximizeBtn = (
    <button
      key="maximize"
      type="button"
      className="wc-btn wc-maximize"
      aria-label={t(isMaximized ? 'common.windowRestore' : 'common.windowMaximize')}
      title={t(isMaximized ? 'common.windowRestore' : 'common.windowMaximize')}
      onClick={handleMaximize}
    >
      {isMaximized ? (
        <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path
            d="M3 1H8.5A.5.5 0 0 1 9 1.5V7"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <rect x="1" y="3" width="6" height="6" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      ) : (
        <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <rect
            x="1.5"
            y="1.5"
            width="7"
            height="7"
            rx="0.5"
            stroke="currentColor"
            strokeWidth="1.3"
          />
        </svg>
      )}
    </button>
  )

  const buttons = isMac
    ? [closeBtn, minimizeBtn, maximizeBtn]
    : [minimizeBtn, maximizeBtn, closeBtn]

  return (
    <div
      className={`wc-group app-nodrag ${isMac ? `wc-mac${!isFocused ? ' wc-blurred' : ''}` : 'wc-win'}`}
    >
      {buttons}
    </div>
  )
}

export default WindowControls
