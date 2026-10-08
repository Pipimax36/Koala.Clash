interface DeepLinkDependencies {
  showWindow(): Promise<void>
  canHandle(): boolean
  handle(url: string): Promise<void>
  onError(): void
}

/** Keep native links in order until startup and the current renderer are ready. */
export function createDeepLinkDispatcher(deps: DeepLinkDependencies) {
  const pending: string[] = []
  let enabled = false
  let draining = false
  let requested = false
  let showRequested = false
  const reportError = (): void => {
    try {
      deps.onError()
    } catch {
      /* A closing renderer must not produce an unhandled rejection. */
    }
  }

  function drain(): void {
    requested = true
    if (!enabled || draining) return
    draining = true
    void (async () => {
      while (requested) {
        requested = false
        if (!pending.length && !showRequested) return
        showRequested = false
        // A deep link must also bring back a window destroyed by lightweight mode.
        await deps.showWindow()
        if (!deps.canHandle()) return
        while (pending.length && deps.canHandle()) {
          const url = pending.shift()!
          try {
            await deps.handle(url)
          } catch {
            // Callers receive no URL, authorization code, or provider error body.
            reportError()
          }
        }
      }
    })()
      .catch(reportError)
      .finally(() => {
        draining = false
        if (requested) drain()
      })
  }

  return {
    enqueue(url: string): void {
      pending.push(url)
      drain()
    },
    enable(): void {
      enabled = true
      drain()
    },
    requestWindow(): void {
      showRequested = true
      drain()
    },
    rendererReady: drain
  }
}
