import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type WebSocket from 'ws'
import { createTrafficStream } from '../src/main/core/traffic-stream'

class FakeSocket extends EventEmitter {
  readyState = 1
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close')
  }
  terminate(): void {
    this.emit('error', new Error('connection cancelled'))
    this.close()
  }
}

test('traffic resumes after a prolonged core outage', () => {
  const sockets: FakeSocket[] = []
  const tasks: Array<() => void> = []
  const received: string[] = []
  const stream = createTrafficStream({
    open: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    onMessage: (data) => received.push(data),
    schedule: (callback) => {
      tasks.push(callback)
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    cancel: () => {}
  })

  stream.start()
  for (let i = 0; i < 12; i++) {
    sockets.at(-1)!.close()
    tasks.shift()?.()
  }
  assert.equal(sockets.length, 13)
  sockets.at(-1)!.emit('message', '42')
  assert.deepEqual(received, ['42'])
  stream.stop()
})

test('stopping traffic cancels a pending reconnect', () => {
  const socket = new FakeSocket()
  let reconnect: (() => void) | undefined
  let opens = 0
  const stream = createTrafficStream({
    open: () => {
      opens++
      return socket as unknown as WebSocket
    },
    onMessage: () => {},
    schedule: (callback) => {
      reconnect = callback
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    cancel: () => {}
  })

  stream.start()
  socket.close()
  stream.stop()
  reconnect?.()
  assert.equal(opens, 1)
})

test('stopping while connecting handles the socket error', () => {
  const socket = new FakeSocket()
  socket.readyState = 0
  const stream = createTrafficStream({
    open: () => socket as unknown as WebSocket,
    onMessage: () => {}
  })

  stream.start()
  assert.doesNotThrow(() => stream.stop())
})
