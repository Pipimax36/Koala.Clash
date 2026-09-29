import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCoreDiagnostics, parseCoreStartupIssue } from '../src/main/core/core-diagnostics'

const routeError =
  'level=error msg="Start TUN listening error: configure tun interface: add route: 1.0.0.0/8: file exists"'
const portError =
  'level=error msg="Start Mixed(http+socks) server error: listen udp :7897: bind: address already in use"'

test('the captured core failures distinguish route conflicts, port conflicts and permissions', () => {
  assert.deepEqual(parseCoreStartupIssue(routeError), { reason: 'tun-route-conflict' })
  assert.deepEqual(parseCoreStartupIssue(portError), { reason: 'port-in-use', port: 7897 })
  assert.deepEqual(
    parseCoreStartupIssue(
      'Start TUN listening error: configure tun interface: Connect: operation not permitted'
    ),
    { reason: 'tun-permission-denied' }
  )
  assert.equal(parseCoreStartupIssue('proxy health check failed: connection refused'), undefined)
})

test('only the current attempt is reported, even when messages are split or duplicated', () => {
  const diagnostics = createCoreDiagnostics()
  diagnostics.push('Start TUN listening error: permission denied\n')
  const before = diagnostics.read()
  assert.deepEqual(before.issues, [])
  diagnostics.push(routeError.slice(0, 25))
  diagnostics.push(portError + '\n', 'stderr')
  diagnostics.push(routeError.slice(25) + '\n' + routeError + '\n')
  assert.deepEqual(diagnostics.read(before.cursor).issues, [
    { reason: 'port-in-use', port: 7897 },
    { reason: 'tun-route-conflict' }
  ])
  const retry = diagnostics.read()
  assert.deepEqual(diagnostics.read(retry.cursor).issues, [])
})

test('restarting clears partial log lines without reusing an earlier cursor', () => {
  const diagnostics = createCoreDiagnostics()
  diagnostics.push(routeError + '\nStart TUN listening error: ')
  const before = diagnostics.read()
  diagnostics.resetBuffers()
  diagnostics.push('permission denied\n')
  assert.deepEqual(diagnostics.read(before.cursor).issues, [])
  diagnostics.push(portError + '\n')
  assert.equal(diagnostics.read(before.cursor).cursor, before.cursor + 1)
})
