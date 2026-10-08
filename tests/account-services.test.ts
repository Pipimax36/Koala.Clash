import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import type { useAccountServices } from '../src/renderer/src/hooks/use-account-services'

type Snapshot = ReturnType<typeof useAccountServices>
const source = readFileSync(
  new URL('../src/renderer/src/hooks/use-account-services.ts', import.meta.url),
  'utf8'
)
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const service = (id: number): KoalaService => ({
  id,
  name: `Service ${id}`,
  imported: false,
  active: false
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// The existing test suite uses in-memory React hook fixtures, so no DOM dependency is needed.
function fixture(api: {
  authListServices(): Promise<KoalaServiceListResult>
  authImportService(serviceId: number): Promise<KoalaServiceImportResult>
}) {
  let cursor = 0
  let disposed = false
  let lateWrites = 0
  const slots: unknown[] = []
  const effects: Array<() => () => void> = []
  const cleanups: Array<() => void> = []
  const react = {
    useState: (initial: unknown) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [
        slots[index],
        (next: unknown) => {
          if (disposed) lateWrites++
          slots[index] = typeof next === 'function' ? next(slots[index]) : next
        }
      ]
    },
    useRef: (initial: unknown) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback: (callback: unknown) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = callback
      return slots[index]
    },
    useEffect: (effect: () => () => void) => {
      const index = cursor++
      if (!(index in slots)) {
        slots[index] = true
        effects.push(effect)
      }
    }
  }
  const exports: { useAccountServices?: () => Snapshot } = {}
  vm.runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (name === 'react') return react
      if (name === '@renderer/utils/ipc') return api
      throw new Error(`Unexpected fixture import: ${name}`)
    }
  })
  const render = (): Snapshot => {
    cursor = 0
    const result = exports.useAccountServices!()
    for (const effect of effects.splice(0)) cleanups.push(effect())
    return result
  }
  render()
  return {
    render,
    unmount: () => {
      disposed = true
      cleanups.forEach((cleanup) => cleanup())
    },
    lateWrites: () => lateWrites
  }
}

test('every opening fetches fresh services and never imports automatically', async () => {
  let lists = 0
  const api = {
    authListServices: async (): Promise<KoalaServiceListResult> => ({
      ok: true,
      services: [service(++lists)]
    }),
    authImportService: async (): Promise<KoalaServiceImportResult> =>
      assert.fail('must wait for an explicit import')
  }
  const first = fixture(api)
  assert.equal(first.render().state.status, 'loading')
  await tick()
  assert.equal(first.render().state.status, 'ready')
  first.unmount()
  const reopened = fixture(api)
  assert.equal(reopened.render().state.status, 'loading')
  await tick()
  const state = reopened.render().state
  assert.equal(lists, 2)
  assert.equal(state.status === 'ready' && state.services[0].id, 2)
  reopened.unmount()
})

test('closing or changing accounts ignores late list results and failures', async () => {
  for (const fail of [false, true]) {
    const old = deferred<KoalaServiceListResult>()
    const first = fixture({
      authListServices: () => old.promise,
      authImportService: async () => assert.fail('no import')
    })
    first.unmount()
    const next = fixture({
      authListServices: async () => ({ ok: true, services: [service(2)] }),
      authImportService: async () => assert.fail('no import')
    })
    if (fail) old.reject(new Error('fixture unavailable'))
    else old.resolve({ ok: true, services: [service(1)] })
    await tick()
    assert.equal(first.lateWrites(), 0)
    const state = next.render().state
    assert.equal(state.status === 'ready' && state.services[0].id, 2)
    next.unmount()
  }
})

test('a newer list request wins over an older response', async () => {
  const old = deferred<KoalaServiceListResult>()
  let requests = 0
  const f = fixture({
    authListServices: async () => (++requests === 1 ? old.promise : { ok: true, services: [] }),
    authImportService: async () => assert.fail('no import')
  })
  await f.render().refresh()
  old.resolve({ ok: true, services: [service(1)] })
  await tick()
  const state = f.render().state
  assert.equal(state.status === 'ready' && state.services.length, 0)
  f.unmount()
})

test('duplicate import clicks send one request and success marks only that service imported', async () => {
  const result = deferred<KoalaServiceImportResult>()
  const requests: number[] = []
  const f = fixture({
    authListServices: async () => ({ ok: true, services: [service(1), service(2)] }),
    authImportService: (id) => {
      requests.push(id)
      return result.promise
    }
  })
  await tick()
  const pending = f.render().importService(1)
  await f.render().importService(1)
  assert.deepEqual(requests, [1])
  assert.equal(f.render().importing.includes(1), true)
  result.resolve({ ok: true, profileId: 'profile-1', alreadyImported: false })
  await pending
  const state = f.render().state
  assert.equal(state.status === 'ready' && state.services[0].imported, true)
  assert.equal(state.status === 'ready' && state.services[0].active, true)
  assert.equal(state.status === 'ready' && state.services[1].imported, false)
  assert.equal(f.render().importing.length, 0)
  await f.render().importService(1)
  assert.deepEqual(requests, [1])
  f.unmount()
})

test('an imported inactive service can be enabled without losing other import states', async () => {
  const requests: number[] = []
  const f = fixture({
    authListServices: async () => ({
      ok: true,
      services: [
        { ...service(1), imported: true },
        { ...service(2), imported: true, active: true },
        service(3)
      ]
    }),
    authImportService: async (id) => {
      requests.push(id)
      return { ok: true, profileId: 'existing-profile', alreadyImported: true }
    }
  })
  await tick()
  assert.deepEqual(requests, [], 'opening the list must not activate a service')
  await f.render().importService(1)
  assert.deepEqual(requests, [1])
  const state = f.render().state
  assert.equal(state.status, 'ready')
  if (state.status !== 'ready') assert.fail('services should stay visible')
  assert.equal(state.services[0].active, true)
  assert.equal(state.services[0].imported, true)
  assert.equal(state.services[1].active, false)
  assert.equal(state.services[1].imported, true)
  assert.equal(state.services[2].active, false)
  assert.equal(state.services[2].imported, false)
  await f.render().importService(1)
  assert.deepEqual(requests, [1], 'the active service must not be activated twice')
  f.unmount()
})

test('activation failure retains the saved service and permits retry while preserving the old active service', async () => {
  let imports = 0
  const f = fixture({
    authListServices: async () => ({
      ok: true,
      services: [service(1), { ...service(2), imported: true, active: true }]
    }),
    authImportService: async () =>
      ++imports === 1
        ? { ok: false, error: 'activation-failed' }
        : { ok: true, profileId: 'saved-profile', alreadyImported: true }
  })
  await tick()
  await f.render().importService(1)
  const failed = f.render().state
  assert.equal(failed.status, 'ready')
  if (failed.status !== 'ready') assert.fail('services should stay visible')
  assert.equal(failed.services[0].imported, true)
  assert.equal(failed.services[0].active, false)
  assert.equal(failed.services[1].active, true)
  assert.equal(f.render().importErrors[1], 'activation-failed')
  assert.equal(f.render().importing.length, 0)
  await f.render().importService(1)
  const retried = f.render().state
  assert.equal(retried.status === 'ready' && retried.services[0].active, true)
  assert.equal(retried.status === 'ready' && retried.services[1].active, false)
  assert.equal(f.render().importErrors[1], undefined)
  assert.equal(imports, 2)
  f.unmount()
})

test('closing during an import suppresses late success, error, and final state writes', async () => {
  for (const fail of [false, true]) {
    const result = deferred<KoalaServiceImportResult>()
    const f = fixture({
      authListServices: async () => ({ ok: true, services: [service(1)] }),
      authImportService: () => result.promise
    })
    await tick()
    const pending = f.render().importService(1)
    f.unmount()
    if (fail) result.reject(new Error('fixture unavailable'))
    else result.resolve({ ok: true, profileId: 'profile-1', alreadyImported: false })
    await pending
    assert.equal(f.lateWrites(), 0)
  }
})

test('list errors remain distinct from an empty list and can be retried', async () => {
  let requests = 0
  const f = fixture({
    authListServices: async () =>
      ++requests === 1 ? { ok: false, error: 'plugin-unavailable' } : { ok: true, services: [] },
    authImportService: async () => assert.fail('no import')
  })
  await tick()
  const error = f.render().state
  assert.equal(error.status === 'error' && error.error, 'plugin-unavailable')
  await f.render().refresh()
  const empty = f.render().state
  assert.equal(empty.status === 'ready' && empty.services.length, 0)
  f.unmount()
})

test('a failed import can be retried and an already imported result is successful', async () => {
  let imports = 0
  const f = fixture({
    authListServices: async () => ({ ok: true, services: [service(1)] }),
    authImportService: async () =>
      ++imports === 1
        ? { ok: false, error: 'service-unavailable' }
        : { ok: true, profileId: 'existing-profile', alreadyImported: true }
  })
  await tick()
  await f.render().importService(1)
  assert.equal(f.render().importErrors[1], 'service-unavailable')
  assert.equal(f.render().importing.length, 0)
  await f.render().importService(1)
  const state = f.render().state
  assert.equal(state.status === 'ready' && state.services[0].imported, true)
  assert.equal(f.render().importErrors[1], undefined)
  f.unmount()
})

function renderedServiceButtons(services: KoalaService[], importing: number[] = []) {
  type Element = { type: string; props: Record<string, unknown> }
  const requests: number[] = []
  const element = (type: string, props: Record<string, unknown>): Element => ({ type, props })
  const component = ts.transpileModule(
    readFileSync(
      new URL('../src/renderer/src/components/auth/account-services.tsx', import.meta.url),
      'utf8'
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX
      }
    }
  ).outputText
  const mocks: Record<string, unknown> = {
    react: { useId: () => 'fixture-services-heading' },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-i18next': {
      useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } })
    },
    'lucide-react': Object.fromEntries(
      ['AlertCircle', 'Check', 'Download', 'LoaderCircle', 'PackageOpen', 'Power', 'RefreshCw'].map(
        (name) => [name, name]
      )
    ),
    '@renderer/components/ui/button': { Button: 'Button' },
    '@renderer/hooks/use-account-services': {
      useAccountServices: () => ({
        state: { status: 'ready', services },
        importing,
        importErrors: {},
        importService: async (id: number) => {
          requests.push(id)
        },
        refresh: async () => assert.fail('rendering must not refresh')
      })
    }
  }
  const exports: { default?: () => Element } = {}
  vm.runInNewContext(component, {
    exports,
    require: (name: string) => {
      if (!(name in mocks)) throw new Error(`Unexpected fixture import: ${name}`)
      return mocks[name]
    }
  })
  const buttons: Element[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit)
    else if (node && typeof node === 'object' && 'type' in node && 'props' in node) {
      const current = node as Element
      if (current.type === 'Button') buttons.push(current)
      visit(current.props.children)
    }
  }
  const tree = exports.default!()
  visit(tree)
  return { buttons, requests, tree }
}

test('service buttons distinguish import-and-enable, enable, and the disabled active service', () => {
  const { buttons, requests } = renderedServiceButtons([
    service(1),
    { ...service(2), imported: true },
    { ...service(3), imported: true, active: true }
  ])
  assert.deepEqual(
    buttons.map((button) => button.props['aria-label']),
    ['auth.services.importName', 'auth.services.activateName', 'auth.services.activeName']
  )
  assert.deepEqual(
    buttons.map((button) => button.props.disabled),
    [false, false, true]
  )
  assert.equal(JSON.stringify(buttons[2]).includes('auth.services.active'), true)
  ;(buttons[1].props.onClick as () => void)()
  assert.deepEqual(requests, [2])
})

test('in-progress buttons distinguish importing from enabling and prevent repeat clicks', () => {
  const { buttons } = renderedServiceButtons(
    [service(1), { ...service(2), imported: true }],
    [1, 2]
  )
  assert.equal(JSON.stringify(buttons[0]).includes('auth.services.importing'), true)
  assert.equal(JSON.stringify(buttons[1]).includes('auth.services.activating'), true)
  assert.deepEqual(
    buttons.map((button) => button.props.disabled),
    [true, true]
  )
})

test('subscription rows keep the plan and expiration without service IDs or import instructions', () => {
  const { tree } = renderedServiceButtons([{ ...service(918273), nextDueDate: '2026-12-01' }])
  const markup = JSON.stringify(tree)
  assert.equal(markup.includes('Service 918273'), true)
  assert.equal(markup.includes('auth.services.nextDueDate'), true)
  assert.equal(markup.includes('auth.services.serviceId'), false)
  assert.equal(markup.includes('auth.services.description'), false)
  assert.equal(markup.includes('ui-account-services-count'), false)
})

function renderedAccount(state: KoalaAuthState): string {
  const element = (type: string, props: Record<string, unknown>) => ({ type, props })
  const source = readFileSync(
    new URL('../src/renderer/src/components/auth/account-control.tsx', import.meta.url),
    'utf8'
  )
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX
    }
  }).outputText
  const noop = () => {}
  const mocks: Record<string, unknown> = {
    react: {
      useState: () => [true, noop],
      useRef: (current: unknown) => ({ current }),
      useEffect: noop
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
    'lucide-react': Object.fromEntries(
      [
        'AlertCircle',
        'ArrowUpRight',
        'ExternalLink',
        'LoaderCircle',
        'LogOut',
        'UserRound',
        'X'
      ].map((name) => [name, name])
    ),
    sonner: { toast: { success: noop, error: noop } },
    '@renderer/components/ui/button': { Button: 'Button' },
    '@renderer/components/ui/dialog': Object.fromEntries(
      [
        'Dialog',
        'DialogClose',
        'DialogContent',
        'DialogDescription',
        'DialogFooter',
        'DialogHeader',
        'DialogTitle'
      ].map((name) => [name, name])
    ),
    '@renderer/hooks/use-koala-auth': {
      useKoalaAuth: () => ({
        state,
        loading: false,
        busy: false,
        login: noop,
        reopenLogin: noop,
        logout: noop,
        cancelLogin: noop
      })
    },
    './account-services': { default: 'AccountServices' },
    './account-control.css': {}
  }
  const exports: { default?: () => unknown } = {}
  vm.runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (!(name in mocks)) throw new Error(`Unexpected fixture import: ${name}`)
      return mocks[name]
    }
  })
  return JSON.stringify(exports.default!())
}

test('signed-in account shows identity and one close control without technical session copy', () => {
  const markup = renderedAccount({
    status: 'signed-in',
    persistence: 'memory',
    user: { id: 'fixture', name: 'Alex Chen', email: 'alex@example.test' }
  })
  assert.equal(markup.includes('Alex Chen'), true)
  assert.equal(markup.includes('alex@example.test'), true)
  assert.equal(markup.includes('auth.signOut'), true)
  assert.equal(markup.includes('AccountServices'), true)
  for (const removed of [
    'COOLGO',
    'auth.signedInDescription',
    'auth.memoryOnly',
    'auth.logoutHint',
    'ui-auth-symbol'
  ]) {
    assert.equal(
      markup.includes(removed),
      false,
      `${removed} should not appear in the account popup`
    )
  }
  assert.equal(markup.match(/common\.close/g)?.length, 1)
})

test('login waiting keeps its browser guidance and retry actions', () => {
  const markup = renderedAccount({ status: 'signing-in', persistence: 'none' })
  for (const retained of [
    'COOLGO',
    'auth.waitingTitle',
    'auth.waitingDescription',
    'auth.reopenBrowser',
    'auth.cancelLogin',
    'auth.waitingHint'
  ]) {
    assert.equal(markup.includes(retained), true)
  }
  assert.equal(markup.includes('AccountServices'), false)
})
