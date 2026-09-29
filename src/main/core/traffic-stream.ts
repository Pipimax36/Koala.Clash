import type WebSocket from 'ws'

interface TrafficStreamOptions {
  open: () => WebSocket
  onMessage: (data: string) => void
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
}

export function createTrafficStream({
  open,
  onMessage,
  schedule = setTimeout,
  cancel = clearTimeout
}: TrafficStreamOptions): { start: () => void; stop: () => void } {
  let active = false
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const connect = (): void => {
    if (!active) return
    timer = null
    const current = open()
    socket = current
    current.on('message', (data) => {
      onMessage(data.toString())
    })
    current.on('close', () => {
      if (!active || socket !== current) return
      socket = null
      timer = schedule(connect, 1000)
    })
    current.on('error', () => {
      // ws emits close after a failed connection; keep its error handled.
    })
  }

  return {
    start: () => {
      if (active) return
      active = true
      connect()
    },
    stop: () => {
      active = false
      if (timer) cancel(timer)
      timer = null
      if (socket) {
        socket.removeAllListeners('message')
        socket.removeAllListeners('close')
        if (socket.readyState === 1) socket.close()
        else if (socket.readyState === 0) socket.terminate()
        socket = null
      }
    }
  }
}
