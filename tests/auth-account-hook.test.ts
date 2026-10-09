import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import type { useKoalaAuth } from '../src/renderer/src/hooks/use-koala-auth'

type Snapshot = ReturnType<typeof useKoalaAuth>
const signedOut: KoalaAuthState = { status: 'signed-out', persistence: 'none' }
const signedIn: KoalaAuthState = {
  status: 'signed-in',
  persistence: 'encrypted',
  user: { id: 'cached-customer' }
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const compiled = ts.transpileModule(
  readFileSync(new URL('../src/renderer/src/hooks/use-koala-auth.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText

function fixture(restore: () => Promise<KoalaAuthState>) {
  let cursor = 0
  const slots: unknown[] = []
  const effects: Array<() => () => void> = []
  const cleanups: Array<() => void> = []
  const events = new Map<string, (...args: unknown[]) => void>()
  const calls: string[] = []
  const add = (name: string, fn: (...args: unknown[]) => void) => events.set(name, fn)
  const remove = (name: string) => events.delete(name)
  const exports: { useKoalaAuth?: () => Snapshot } = {}
  vm.runInNewContext(compiled, {
    exports,
    window: {
      electron: { ipcRenderer: { on: add, removeListener: remove } },
      addEventListener: add,
      removeEventListener: remove
    },
    require: (name: string) => {
      if (name === 'react')
        return {
          useState: (initial: unknown) => {
            const index = cursor++
            if (!(index in slots)) slots[index] = initial
            return [
              slots[index],
              (next: unknown) => {
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
      if (name === '@renderer/utils/ipc')
        return {
          authGetState: async () => {
            calls.push('get')
            return signedOut
          },
          authRestoreSession: async () => {
            calls.push('restore')
            return restore()
          },
          authLogin: async () => {
            calls.push('login')
            return { status: 'signing-in', persistence: 'none' }
          }
        }
      throw new Error(`Unexpected import: ${name}`)
    }
  })
  const render = (): Snapshot => {
    cursor = 0
    const result = exports.useKoalaAuth!()
    effects.splice(0).forEach((effect) => cleanups.push(effect()))
    return result
  }
  render()
  return {
    render,
    calls,
    focus: () => events.get('focus')?.(),
    unmount: () => cleanups.forEach((cleanup) => cleanup())
  }
}

test('mount and focus only request the memory snapshot, while clicking restores a cached account', async () => {
  const f = fixture(async () => signedIn)
  await tick()
  f.focus()
  await tick()
  assert.deepEqual(f.calls, ['get', 'get'])
  await f.render().openAccount()
  assert.deepEqual(f.calls, ['get', 'get', 'restore'])
  assert.equal(f.render().state.status, 'signed-in')
  f.unmount()
})

test('an account click opens the browser only after confirming no remembered account exists', async () => {
  let release!: (state: KoalaAuthState) => void
  const f = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  await tick()
  const opening = f.render().openAccount()
  await f.render().openAccount()
  f.focus()
  assert.equal(f.render().restoring, true)
  assert.deepEqual(f.calls, ['get', 'restore'])
  release(signedOut)
  await opening
  assert.deepEqual(f.calls, ['get', 'restore', 'login'])
  assert.equal(f.render().restoring, false)
  f.unmount()
})

test('denied restoration stays retryable without automatic browser or focus retries', async () => {
  let allowed = false
  const f = fixture(async () => (allowed ? signedIn : { ...signedOut, error: 'storage-error' }))
  await tick()
  await f.render().openAccount()
  assert.equal(f.render().state.error, 'storage-error')
  f.focus()
  await tick()
  assert.deepEqual(f.calls, ['get', 'restore', 'get'])
  allowed = true
  await f.render().openAccount()
  assert.equal(f.render().state.status, 'signed-in')
  assert.equal(f.calls.includes('login'), false)
  f.unmount()
})

test('unmounting during restoration prevents a delayed browser launch', async () => {
  let release!: (state: KoalaAuthState) => void
  const f = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  await tick()
  const opening = f.render().openAccount()
  f.unmount()
  release(signedOut)
  await opening
  assert.deepEqual(f.calls, ['get', 'restore'])
})
