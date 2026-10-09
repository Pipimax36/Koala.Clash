import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

type Element = { type: unknown; props: Record<string, unknown> }

function findSelect(value: unknown, selected: string): Element | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findSelect(child, selected)
      if (found) return found
    }
  } else if (value && typeof value === 'object' && 'type' in value && 'props' in value) {
    const element = value as Element
    if (element.type === 'Select' && element.props.value === selected) return element
    return findSelect(element.props.children, selected)
  }
  return undefined
}

const compiled = ts.transpileModule(
  readFileSync(new URL('../src/renderer/src/pages/mihomo.tsx', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }
).outputText
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function fixture(core: 'mihomo' | 'system', save: (patch: Record<string, unknown>) => Promise<void>) {
  const events: string[] = []
  const savedPath = core === 'system' ? '/test/old-mihomo' : ''
  const element = (type: unknown, props: Record<string, unknown>): Element => ({ type, props })
  const patch = async (value: Record<string, unknown>): Promise<void> => {
    events.push(`save:${JSON.stringify(value)}`)
    await save(value)
  }
  const mocks: Record<string, unknown> = {
    sonner: { toast: { error: () => events.push('error') } },
    swr: (key: string) => ({
      data: key === 'systemCorePath' ? savedPath : undefined,
      mutate: async () => events.push(`refresh:${key}`)
    }),
    react: {
      useState: (initial: unknown) => [initial, () => {}],
      useEffect: () => {}
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    '@renderer/hooks/use-app-config': {
      useAppConfig: () => ({
        appConfig: { core },
        // Reproduce the existing context helper's swallowed rejection.
        patchAppConfig: async (value: Record<string, unknown>) => {
          try {
            await patch(value)
          } catch {
            events.push('context-error')
          }
        },
        mutateAppConfig: () => events.push('refresh:config')
      })
    },
    '@renderer/hooks/use-controled-mihomo-config': {
      useControledMihomoConfig: () => ({ controledMihomoConfig: {} })
    },
    '@renderer/utils/init': { platform: 'darwin' },
    'pubsub-js': { publish: () => events.push('published') },
    '@renderer/utils/ipc': {
      findSystemMihomo: async () => ['/test/new-mihomo'],
      getSystemCorePath: async () => savedPath,
      patchAppConfig: patch,
      restartCore: async () => events.push('restart')
    },
    'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
    'react-router-dom': { useLocation: () => ({}), useNavigate: () => () => {} },
    '@renderer/hooks/use-proxy-control': { useProxyControl: () => ({}) },
    '@renderer/store/connections-store': { useConnectionsStore: () => 0 },
    '@renderer/store/core-lifecycle-store': { useCoreLifecycleStore: () => 0 }
  }
  const exports: { default?: () => Element } = {}
  vm.runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (name in mocks) return mocks[name]
      if (name.startsWith('@renderer/components/') || name === 'lucide-react') {
        return new Proxy({ __esModule: true }, { get: (target, key) => target[key] ?? key })
      }
      throw new Error(`Unexpected import: ${name}`)
    }
  })
  return {
    events,
    change: async (selected: string, next: string) => {
      const select = findSelect(exports.default!(), selected)
      assert.ok(select, `Missing select with value ${selected}`)
      await (select.props.onValueChange as (value: string) => Promise<void> | void)(next)
      await tick()
    }
  }
}

test('denied system path save does not switch the core or restart it', async () => {
  const f = fixture('mihomo', async () => {
    throw new Error('Secure storage is unavailable')
  })
  await f.change('mihomo', 'system')
  assert.deepEqual(f.events, ['save:{"systemCorePath":"/test/new-mihomo"}', 'error'])
})

test('denied path replacement does not refresh the displayed path or restart the core', async () => {
  const f = fixture('system', async () => {
    throw new Error('Secure storage is unavailable')
  })
  await f.change('/test/old-mihomo', '/test/new-mihomo')
  assert.deepEqual(f.events, ['save:{"systemCorePath":"/test/new-mihomo"}', 'error'])
})

test('successful system path save refreshes configuration before switching and restarting', async () => {
  const f = fixture('mihomo', async () => {})
  await f.change('mihomo', 'system')
  assert.deepEqual(f.events, [
    'save:{"systemCorePath":"/test/new-mihomo"}',
    'refresh:config',
    'save:{"core":"system"}',
    'refresh:config',
    'restart',
    'published'
  ])
})
