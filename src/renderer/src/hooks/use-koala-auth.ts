import { useCallback, useEffect, useRef, useState } from 'react'
import {
  authCancelLogin,
  authGetState,
  authLogin,
  authLogout,
  authReopenLogin,
  authRestoreSession
} from '@renderer/utils/ipc'

const signedOut: KoalaAuthState = { status: 'signed-out', persistence: 'none' }

export function useKoalaAuth() {
  const [state, setState] = useState<KoalaAuthState>(signedOut)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const mounted = useRef(false)
  const revision = useRef(0)
  const actionPending = useRef(false)

  useEffect(() => {
    mounted.current = true
    let refreshing = false
    const onStateChanged = (_event: unknown, nextState: KoalaAuthState): void => {
      revision.current++
      setState(nextState)
      setLoading(false)
    }
    const refresh = async (): Promise<void> => {
      if (refreshing || actionPending.current) return
      refreshing = true
      const currentRevision = revision.current
      try {
        const nextState = await authGetState()
        if (mounted.current && currentRevision === revision.current) setState(nextState)
      } catch {
        if (mounted.current && currentRevision === revision.current) {
          setState((current) => ({ ...current, error: 'server-error' }))
        }
      } finally {
        refreshing = false
        if (mounted.current) setLoading(false)
      }
    }
    window.electron.ipcRenderer.on('authStateChanged', onStateChanged)
    window.addEventListener('focus', refresh)
    void refresh()
    return () => {
      mounted.current = false
      revision.current++
      window.electron.ipcRenderer.removeListener('authStateChanged', onStateChanged)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const run = useCallback(async (action: () => Promise<KoalaAuthState>): Promise<void> => {
    if (actionPending.current) return
    actionPending.current = true
    setBusy(true)
    setState((current) => ({ ...current, error: undefined }))
    const currentRevision = ++revision.current
    try {
      const nextState = await action()
      // A later event always wins over an older IPC response.
      if (mounted.current && currentRevision === revision.current) setState(nextState)
    } catch {
      if (mounted.current && currentRevision === revision.current) {
        setState((current) => ({ ...current, error: 'server-error' }))
      }
    } finally {
      actionPending.current = false
      if (mounted.current) setBusy(false)
    }
  }, [])

  return {
    state,
    loading,
    busy,
    restoring,
    openAccount: () =>
      run(async () => {
        setRestoring(true)
        let restored: KoalaAuthState
        try {
          restored = await authRestoreSession()
        } finally {
          if (mounted.current) setRestoring(false)
        }
        if (mounted.current && restored.status === 'signed-out' && !restored.error) {
          return authLogin()
        }
        return restored
      }),
    login: () => run(authLogin),
    reopenLogin: () => run(authReopenLogin),
    logout: () => run(authLogout),
    cancelLogin: () => run(authCancelLogin)
  }
}
