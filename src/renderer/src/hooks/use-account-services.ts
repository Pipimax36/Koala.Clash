import { useCallback, useEffect, useRef, useState } from 'react'
import { authImportService, authListServices } from '@renderer/utils/ipc'

type ServicesState =
  | { status: 'loading' }
  | { status: 'ready'; services: KoalaService[] }
  | { status: 'error'; error: KoalaServiceError }

/** Mount once per open account dialog; no service list survives closing or changing accounts. */
export function useAccountServices() {
  const [state, setState] = useState<ServicesState>({ status: 'loading' })
  const [importing, setImporting] = useState<number[]>([])
  const [importErrors, setImportErrors] = useState<Record<number, KoalaServiceError>>({})
  const mounted = useRef(false)
  const revision = useRef(0)
  const pendingImports = useRef(new Set<number>())

  const refresh = useCallback(async (): Promise<void> => {
    if (!mounted.current) return
    const currentRevision = ++revision.current
    setState({ status: 'loading' })
    setImportErrors({})
    try {
      const result = await authListServices()
      if (!mounted.current || currentRevision !== revision.current) return
      setState(
        result.ok
          ? { status: 'ready', services: result.services }
          : { status: 'error', error: result.error }
      )
    } catch {
      if (mounted.current && currentRevision === revision.current) {
        setState({ status: 'error', error: 'network-error' })
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      revision.current++
      pendingImports.current.clear()
    }
  }, [refresh])

  const importService = async (serviceId: number): Promise<void> => {
    if (
      !mounted.current ||
      state.status !== 'ready' ||
      !state.services.some((service) => service.id === serviceId && !service.active) ||
      pendingImports.current.has(serviceId)
    ) {
      return
    }
    const currentRevision = revision.current
    pendingImports.current.add(serviceId)
    setImporting([...pendingImports.current])
    setImportErrors((errors) => {
      const next = { ...errors }
      delete next[serviceId]
      return next
    })
    try {
      const result = await authImportService(serviceId)
      if (!mounted.current || currentRevision !== revision.current) return
      if (result.ok) {
        setState((current) =>
          current.status === 'ready'
            ? {
                status: 'ready',
                services: current.services.map((service) =>
                  service.id === serviceId
                    ? { ...service, imported: true, active: true }
                    : { ...service, active: false }
                )
              }
            : current
        )
      } else {
        if (result.error === 'activation-failed') {
          setState((current) =>
            current.status === 'ready'
              ? {
                  status: 'ready',
                  services: current.services.map((service) =>
                    service.id === serviceId
                      ? { ...service, imported: true, active: false }
                      : service
                  )
                }
              : current
          )
        }
        setImportErrors((errors) => ({ ...errors, [serviceId]: result.error }))
      }
    } catch {
      if (mounted.current && currentRevision === revision.current) {
        setImportErrors((errors) => ({ ...errors, [serviceId]: 'import-failed' }))
      }
    } finally {
      if (mounted.current && currentRevision === revision.current) {
        pendingImports.current.delete(serviceId)
        setImporting([...pendingImports.current])
      }
    }
  }

  return { state, importing, importErrors, refresh, importService }
}
