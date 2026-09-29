import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

/* eslint-disable @typescript-eslint/no-explicit-any -- VM exports cross an untyped boundary. */
// Execute a real main-process module with only its OS/network boundaries replaced.
export function loadMainModule(
  file: URL,
  mocks: Record<string, unknown>,
  globals: Record<string, unknown> = {}
): Record<string, (...args: any[]) => any> {
  const require = createRequire(file)
  const context = vm.createContext({
    exports: {},
    process,
    Buffer,
    console,
    setTimeout,
    clearTimeout,
    ...globals,
    require: (name: string) => (name in mocks ? mocks[name] : require(name))
  })
  vm.runInContext(
    ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }).outputText,
    context
  )
  return context.exports
}
