import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

type Element = {
  type: string
  props: Record<string, unknown>
}

function isElement(value: unknown): value is Element {
  return value !== null && typeof value === 'object' && 'type' in value && 'props' in value
}

function findElement(root: unknown, predicate: (element: Element) => boolean): Element {
  if (Array.isArray(root)) {
    for (const child of root) {
      try {
        return findElement(child, predicate)
      } catch {
        // Continue through the rendered siblings.
      }
    }
  } else if (isElement(root)) {
    if (predicate(root)) return root
    return findElement(root.props.children, predicate)
  }
  throw new Error('Rendered element not found')
}

function hasText(value: unknown, target: string): boolean {
  if (value === target) return true
  if (Array.isArray(value)) return value.some((child) => hasText(child, target))
  return isElement(value) && hasText(value.props.children, target)
}

test('update IPC resolves while the old window remains open and the modal becomes closable', async () => {
  let downloading = false
  let ipcCalls = 0
  let closeCalls = 0
  let closeButtonClicks = 0
  let latestDialog: Element | undefined

  const element = (type: string, props: Record<string, unknown>): Element => ({ type, props })
  const closeRef = {
    current: {
      click: () => {
        closeButtonClicks++
        ;(latestDialog?.props.onOpenChange as (open: boolean) => void)(false)
      }
    }
  }
  const mocks: Record<string, unknown> = {
    '../../../../shared/app-update': { appReleaseUrl: () => 'https://example.test/release' },
    sonner: { toast: { error: () => assert.fail('update IPC should resolve') } },
    '@renderer/components/ui/dialog': {
      Dialog: 'Dialog',
      DialogClose: 'DialogClose',
      DialogContent: 'DialogContent',
      DialogFooter: 'DialogFooter',
      DialogHeader: 'DialogHeader',
      DialogTitle: 'DialogTitle'
    },
    '@renderer/components/ui/button': { Button: 'Button' },
    '@renderer/components/ui/progress': { Progress: 'Progress' },
    '@renderer/components/ui/spinner': { Spinner: 'Spinner' },
    'react-markdown': 'ReactMarkdown',
    react: {
      useState: () => [downloading, (next: boolean) => (downloading = next)],
      useRef: () => closeRef
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    '@renderer/utils/ipc': {
      downloadAndInstallUpdate: async (version: string) => {
        assert.equal(version, 'v1.4.2')
        ipcCalls++
        // IPC resolves while this renderer process is still alive.
      }
    },
    'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
    'lucide-react': { Download: 'Download', X: 'X' }
  }
  const file = new URL('../src/renderer/src/components/updater/updater-modal.tsx', import.meta.url)
  const source = readFileSync(file, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText
  const exports: Record<string, unknown> = {}
  vm.runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (!(name in mocks)) throw new Error(`Unexpected import: ${name}`)
      return mocks[name]
    }
  })
  const UpdaterModal = exports.default as (props: {
    version: string
    changelog: string
    onClose: () => void
  }) => Element
  const render = (): Element => {
    latestDialog = UpdaterModal({
      version: 'v1.4.2',
      changelog: 'Fixture release',
      onClose: () => closeCalls++
    })
    return latestDialog
  }

  const initial = render()
  const updateButton = findElement(
    initial,
    (node) => node.type === 'Button' && hasText(node.props.children, 'updater.updateNow')
  )
  await (updateButton.props.onClick as () => Promise<void>)()
  assert.equal(ipcCalls, 1)

  const afterHandoff = render()
  const currentUpdateButton = findElement(
    afterHandoff,
    (node) => node.type === 'Button' && hasText(node.props.children, 'updater.updateNow')
  )
  const cancelButton = findElement(
    afterHandoff,
    (node) => node.type === 'Button' && hasText(node.props.children, 'common.cancel')
  )
  ;(cancelButton.props.onClick as () => void)()

  assert.deepEqual(
    {
      updateButtonDisabled: currentUpdateButton.props.disabled,
      closeButtonClicks,
      closeCalls
    },
    { updateButtonDisabled: false, closeButtonClicks: 1, closeCalls: 1 }
  )
})
