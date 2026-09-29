import { create } from 'zustand'

interface ConnectionClock {
  startedAt: number | null
  observeConnected: (connected: boolean) => void
}

export const useConnectionClock = create<ConnectionClock>((set, get) => ({
  startedAt: null,
  observeConnected: (connected) => {
    const { startedAt } = get()
    if (connected && startedAt === null) set({ startedAt: Date.now() })
    if (!connected && startedAt !== null) set({ startedAt: null })
  }
}))
