import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { createDeepLinkDispatcher } from '../src/main/utils/deep-link-dispatcher'

const requireModule = createRequire(import.meta.url)
const root = path.resolve(__dirname, '..')
const source = readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true
  }
}).outputText
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const callback = 'koala-clash://auth/callback?state=fixture-state&code=fixture-code'

function fixture(
  options: { platform?: string; argv?: string[]; initialized?: Promise<void> } = {}
) {
  const app = new EventEmitter() as EventEmitter & Record<string, unknown>
  let ready = false
  let releaseReady!: () => void
  const readyPromise = new Promise<void>((resolve) => {
    releaseReady = resolve
  })
  const handled: string[] = []
  const errors: string[] = []
  const windows: FakeWindow[] = []
  const config = { disableTray: true, silentStart: true, corePermissionMode: 'service' }
  let handle = async (_url: string): Promise<boolean> => true
  Object.assign(app, {
    whenReady: () => readyPromise,
    isReady: () => ready,
    requestSingleInstanceLock: () => true,
    quit: () => {},
    exit: () => {},
    disableHardwareAcceleration: () => {},
    dock: { setIcon: () => {}, hide: () => {} },
    commandLine: { appendSwitch: () => {} }
  })
  class FakeContents extends EventEmitter {
    loading = true
    isLoading() {
      return this.loading
    }
    send(channel: string, _title: string, message: string) {
      if (channel === 'showError') errors.push(message)
    }
    reload() {
      this.loading = true
    }
    invalidate() {
      // Rendering itself is outside the native-link fixture.
    }
    setWindowOpenHandler() {
      // The fixture never opens renderer-created windows.
    }
    forcefullyCrashRenderer() {
      // Renderer crashes are not triggered by these cases.
    }
  }
  class FakeWindow extends EventEmitter {
    webContents = new FakeContents()
    destroyed = false
    visible = false
    shown = 0
    constructor() {
      super()
      assert.equal(ready, true, 'window creation must wait for Electron readiness')
      windows.push(this)
    }
    isDestroyed() {
      return this.destroyed
    }
    isVisible() {
      return this.visible
    }
    isMinimized() {
      return false
    }
    show() {
      assert.equal(this.destroyed, false)
      this.visible = true
      this.shown++
    }
    hide() {
      this.visible = false
    }
    restore() {
      // Fixture windows are never minimized.
    }
    focus() {
      // Focus does not affect callback delivery.
    }
    focusOnWebView() {
      // Native focus is not simulated.
    }
    setAlwaysOnTop() {
      // Window decoration does not affect callback delivery.
    }
    setWindowButtonVisibility() {
      // Native window buttons are not simulated.
    }
    loadFile() {
      this.webContents.loading = true
      return Promise.resolve()
    }
    loadURL() {
      return this.loadFile()
    }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
    finishLoad() {
      this.webContents.loading = false
      this.webContents.emit('did-finish-load')
    }
  }
  const noop = () => {}
  const asyncNoop = async () => {}
  const mocks: Record<string, unknown> = {
    '@electron-toolkit/utils': {
      electronApp: { setAppUserModelId: noop },
      is: { dev: false },
      optimizer: { watchWindowShortcuts: noop }
    },
    'electron-window-state': () => ({ width: 800, height: 700, manage: noop, saveState: noop }),
    electron: {
      app,
      BrowserWindow: FakeWindow,
      dialog: { showErrorBox: (_title: string, message: string) => errors.push(message) },
      ipcMain: new EventEmitter(),
      Menu: { setApplicationMenu: noop },
      Notification: class {
        show() {
          // Notifications are not part of the native-link fixture.
        }
      },
      powerMonitor: new EventEmitter(),
      shell: { openExternal: asyncNoop }
    },
    './utils/ipc': { registerIpcMainHandlers: noop },
    './config': {
      getAppConfig: async () => config,
      patchControledMihomoConfig: asyncNoop,
      addProfileItem: asyncNoop
    },
    './config/app': { getAppConfigSync: () => config },
    './core/manager': {
      startCore: async () => [Promise.resolve()],
      stopCore: asyncNoop,
      quitWithoutCore: asyncNoop
    },
    './sys/sysproxy': { triggerSysProxy: asyncNoop },
    '../../resources/icon.png?asset': 'fixture-icon',
    './resolve/tray': { createTray: asyncNoop },
    './resolve/menu': { createApplicationMenu: asyncNoop },
    './utils/init': { init: () => options.initialized ?? Promise.resolve() },
    './resolve/shortcut': { initShortcut: asyncNoop },
    './sys/misc': { createElevateTaskSync: noop },
    './core/profileUpdater': { initProfileUpdater: asyncNoop },
    './utils/dirs': { exePath: () => '/fixture/Koala', taskDir: () => '/fixture' },
    './resolve/floatingWindow': { showFloatingWindow: asyncNoop },
    './utils/elevation': { declineElevation: asyncNoop, ELEVATION_DECLINED_ARG: 'test-declined' },
    './utils/i18n': { t: (key: string) => key },
    './auth': {
      handleAuthCallback: async (url: string) => {
        handled.push(url)
        return handle(url)
      }
    },
    fs: { existsSync: () => false, writeFileSync: noop },
    child_process: { spawn: noop, execSync: noop }
  }
  const module = { exports: {} }
  vm.runInNewContext(
    compiled,
    {
      module,
      exports: module.exports,
      require: (name: string) =>
        name in mocks
          ? mocks[name]
          : requireModule(name.startsWith('./') ? path.join(root, 'src/main', name) : name),
      __dirname: path.join(root, 'src/main'),
      Buffer,
      URL,
      process: {
        platform: options.platform ?? 'darwin',
        argv: options.argv ?? ['/fixture/Koala'],
        env: {},
        pid: 123
      },
      setTimeout: (fn: () => void) => {
        queueMicrotask(fn)
        return { unref: noop }
      },
      clearTimeout: noop
    },
    { filename: path.join(root, 'src/main/index.ts') }
  )
  return {
    app,
    windows,
    handled,
    errors,
    handler: (next: typeof handle) => {
      handle = next
    },
    ready: async () => {
      ready = true
      releaseReady()
      await tick()
      await tick()
    },
    open: (url: string) => app.emit('open-url', { preventDefault: noop }, url)
  }
}

test('a native callback recreates a destroyed main window and waits for the replacement renderer', async () => {
  const f = fixture()
  await f.ready()
  f.windows[0].finishLoad()
  f.windows[0].destroy()
  f.open(callback)
  await tick()
  assert.equal(f.windows.length, 2)
  assert.equal(f.handled.length, 0)
  f.windows[1].finishLoad()
  await tick()
  assert.deepEqual(f.handled, [callback])
  assert.ok(f.windows[1].shown > 0)
})

test('cold-start callbacks wait for app initialization and preserve all native and argument links', async () => {
  let initialized!: () => void
  const init = new Promise<void>((resolve) => {
    initialized = resolve
  })
  const fromArgs = 'mihomo://install-config?url=https%3A%2F%2Fexample.com%2Fprofile'
  const importLink = 'clash://install-config?url=https%3A%2F%2Fexample.com%2Fother'
  const second = callback + '-second'
  const f = fixture({ initialized: init, argv: ['/fixture/Koala', fromArgs] })
  f.open(callback)
  f.open(importLink)
  f.app.emit('second-instance', {}, ['/fixture/Koala', second])
  await tick()
  assert.equal(f.windows.length, 0)
  await f.ready()
  assert.equal(f.windows.length, 0)
  assert.equal(f.handled.length, 0)
  initialized()
  await tick()
  await tick()
  assert.equal(f.windows.length, 1)
  assert.equal(f.handled.length, 0)
  f.windows[0].finishLoad()
  await tick()
  assert.deepEqual(f.handled, [callback, importLink, second, fromArgs])
})

test('callbacks arriving during a renderer reload are drained after every did-finish-load', async () => {
  const f = fixture()
  await f.ready()
  f.windows[0].finishLoad()
  await tick()
  f.windows[0].webContents.reload()
  f.open(callback)
  f.open(callback + '-second')
  await tick()
  assert.equal(f.handled.length, 0)
  f.windows[0].finishLoad()
  await tick()
  assert.deepEqual(f.handled, [callback, callback + '-second'])
})

test('Windows second-instance delivery recreates the window and preserves all command-line links', async () => {
  const f = fixture({ platform: 'win32' })
  await f.ready()
  f.windows[0].finishLoad()
  f.windows[0].destroy()
  const importLink = 'koala-clash://install-config?url=https%3A%2F%2Fexample.com%2Fprofile'
  f.app.emit('second-instance', {}, ['/fixture/Koala', callback, '--flag', importLink])
  await tick()
  assert.equal(f.windows.length, 2)
  assert.equal(f.handled.length, 0)
  f.windows[1].finishLoad()
  await tick()
  assert.deepEqual(f.handled, [callback, importLink])
})

test('a destroyed window reference is replaced before showing or handling a callback', async () => {
  const f = fixture()
  await f.ready()
  f.windows[0].finishLoad()
  // Model destruction observed before the closed event has cleared the reference.
  f.windows[0].destroyed = true
  f.open(callback)
  await tick()
  assert.equal(f.windows.length, 2)
  f.windows[1].finishLoad()
  await tick()
  assert.deepEqual(f.handled, [callback])
})

test('delivery is serialized and pauses remaining links if the renderer reloads mid-handler', async () => {
  const f = fixture()
  await f.ready()
  f.windows[0].finishLoad()
  let release!: () => void
  f.handler(async (url) => {
    if (url === callback)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    return true
  })
  f.open(callback)
  await tick()
  f.open(callback + '-second')
  await tick()
  assert.deepEqual(f.handled, [callback])
  f.windows[0].webContents.reload()
  release()
  await tick()
  assert.deepEqual(f.handled, [callback])
  f.windows[0].finishLoad()
  await tick()
  assert.deepEqual(f.handled, [callback, callback + '-second'])
})

test('failed delivery is handled without exposing URL details and does not drop the next link', async () => {
  const f = fixture()
  await f.ready()
  f.windows[0].finishLoad()
  f.handler(async (url) => {
    if (url === callback) throw new Error(`Sensitive ${url}`)
    return true
  })
  f.open(callback)
  f.open(callback + '-second')
  await tick()
  assert.deepEqual(f.handled, [callback, callback + '-second'])
  assert.deepEqual(f.errors, ['error.requestFailed'])
})

test('a second instance without a URL also waits for readiness before showing the window', async () => {
  const f = fixture({ platform: 'win32' })
  f.app.emit('second-instance', {}, ['/fixture/Koala'])
  await tick()
  assert.equal(f.windows.length, 0)
  await f.ready()
  assert.equal(f.windows.length, 1)
  assert.ok(f.windows[0].shown > 0)
})

test('an error notification failure cannot reject the dispatcher or stop subsequent links', async () => {
  const handled: string[] = []
  const dispatch = createDeepLinkDispatcher({
    showWindow: async () => {},
    canHandle: () => true,
    handle: async (url) => {
      handled.push(url)
      throw new Error('fixture failure')
    },
    onError: () => {
      throw new Error('renderer already closed')
    }
  })
  dispatch.enable()
  dispatch.enqueue('first')
  dispatch.enqueue('second')
  await tick()
  assert.deepEqual(handled, ['first', 'second'])
})
