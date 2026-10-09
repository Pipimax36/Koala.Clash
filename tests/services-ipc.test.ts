import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

test('service IPC requires the current main window top frame and only forwards the service ID', async () => {
  const source = readFileSync(path.resolve(__dirname, '../src/main/utils/ipc.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const frame = {}
  const webContents = { mainFrame: frame }
  const main = { mainWindow: { webContents } }
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const calls: unknown[][] = []
  const noOp = () => undefined
  const generic = new Proxy({}, { get: () => noOp })
  const module = { exports: {} as { registerIpcMainHandlers(): void } }
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name === 'electron')
        return {
          ipcMain: {
            handle: (key: string, handler: (...args: unknown[]) => unknown) =>
              handlers.set(key, handler),
            on: noOp
          }
        }
      if (name === '..') return main
      if (name === '../auth')
        return {
          authGetState: noOp,
          authRestoreSession: async (...args: unknown[]) => {
            calls.push(args)
            return { status: 'signed-out', persistence: 'none' }
          },
          authLogin: noOp,
          authReopenLogin: noOp,
          authLogout: noOp,
          authCancelLogin: noOp,
          authListServices: async (...args: unknown[]) => {
            calls.push(args)
            return { ok: true, services: [] }
          },
          authImportService: async (...args: unknown[]) => {
            calls.push(args)
            return { ok: true, profileId: 'safe-id', alreadyImported: false }
          }
        }
      return generic
    }
  })
  module.exports.registerIpcMainHandlers()
  for (const channel of ['authRestoreSession', 'authListServices', 'authImportService']) {
    const handler = handlers.get(channel)!
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: webContents, senderFrame: {} }
    ]) {
      const result = await handler(event, 72)
      assert.equal((result as { invokeError: string }).invokeError, 'Unauthorized account request')
    }
  }
  assert.deepEqual(calls, [])
  const event = { sender: webContents, senderFrame: frame }
  await handlers.get('authListServices')!(event, 'do-not-forward-token')
  await handlers.get('authImportService')!(event, 72, 'do-not-forward-url')
  await handlers.get('authRestoreSession')!(event, 'do-not-forward-token')
  assert.deepEqual(calls, [[], [72], []])
})
