import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  grantMacCorePermission,
  getMacCoreInstallPath,
  isPrivilegedExecutable,
  toAppleScript,
  quoteShellArg
} from '../src/main/core/core-permissions'

test('macOS authorization stages the core before elevation, outside Documents', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'koala-permission-test-'))
  const source = path.join(fixture, 'Documents', 'Koala', 'mihomo')
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, 'fixture core')
  let stagedPath = ''
  let verified = false
  try {
    await grantMacCorePermission(source, {
      runAdmin: async (script, staged) => {
        stagedPath = staged
        // Reproduce the reported failure if the elevated command still touches Documents.
        if (script.includes('/Documents/')) throw new Error('chown: Operation not permitted (1)')
        assert.equal(await readFile(staged, 'utf8'), 'fixture core')
        assert.ok(script.includes('/Library/Application Support/Koala Clash/Cores'))
        execFileSync('/bin/sh', ['-n'], { input: script })
        if (process.platform === 'darwin') {
          execFileSync('/usr/bin/osacompile', ['-o', path.join(fixture, 'authorization.scpt')], {
            input: toAppleScript(script)
          })
        }
      },
      verify: (installed) => {
        assert.equal(installed, getMacCoreInstallPath(source))
        verified = true
        return true
      }
    })
    assert.ok(verified)
    assert.equal(existsSync(stagedPath), false)
    assert.equal(await readFile(source, 'utf8'), 'fixture core')
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('the real authorization handler uses the staged copy and restarts the active core', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'koala-permission-test-'))
  const source = path.join(fixture, 'Documents', 'mihomo')
  await mkdir(path.dirname(source))
  await writeFile(source, 'fixture core')
  const events: string[] = []
  let authorized = false
  const require = createRequire(import.meta.url)
  const context = vm.createContext({
    exports: {},
    process: { platform: 'darwin' },
    recordRestart: () => events.push('restart'),
    require(name: string) {
      if (name === './core-permissions')
        return {
          grantMacCorePermission: (file: string) =>
            grantMacCorePermission(file, {
              runAdmin: async (script) => {
                if (script.includes('/Documents/'))
                  throw new Error('chown: Operation not permitted (1)')
                events.push('authorize')
                authorized = true
              },
              verify: () => authorized
            }),
          hasCorePermission: () => authorized
        }
      if (name === '../utils/dirs')
        return {
          mihomoSourcePath: () => source,
          mihomoCorePath: () => (authorized ? getMacCoreInstallPath(source) : source),
          logPath: () => path.join(fixture, 'core.log')
        }
      if (name === '../config') return { getAppConfig: async () => ({ core: 'mihomo' }) }
      if (name === '../utils/i18n') return { t: (key: string) => key }
      if (['child_process', 'util', 'path', 'os', 'fs', 'fs/promises'].includes(name))
        return require(name)
      return {}
    }
  })
  const manager = readFileSync(new URL('../src/main/core/manager.ts', import.meta.url), 'utf8')
  try {
    vm.runInContext(
      ts.transpileModule(manager, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText,
      context
    )
    vm.runInContext(
      'child = { pid: 123, killed: false }; restartCore = async () => recordRestart()',
      context
    )
    await context.exports.manualGrantCorePermition(['mihomo'])
    assert.deepEqual(events, ['authorize', 'restart'])
    assert.equal(context.exports.checkCorePermissionSync('mihomo'), true)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('failed or cancelled authorization cleans staging and never reports success', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'koala-permission-test-'))
  const source = path.join(fixture, 'mihomo')
  await writeFile(source, 'fixture core')
  let stagedPath = ''
  try {
    await assert.rejects(
      grantMacCorePermission(source, {
        runAdmin: async (_, staged) => {
          stagedPath = staged
          throw new Error('User canceled. (-128)')
        },
        verify: () => assert.fail('must not verify after cancellation')
      }),
      /\(-128\)/
    )
    assert.equal(existsSync(stagedPath), false)
    await assert.rejects(
      grantMacCorePermission(source, { runAdmin: async () => {}, verify: () => false }),
      /verification/i
    )
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('a new bundled core requires its own authorization', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'koala-permission-test-'))
  const source = path.join(fixture, 'mihomo')
  try {
    await writeFile(source, 'first version')
    const first = getMacCoreInstallPath(source)
    await writeFile(source, 'second version')
    assert.notEqual(getMacCoreInstallPath(source), first)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('setgid, non-root setuid and writable binaries are not accepted as authorized', () => {
  const stat = (uid: number, mode: number) => ({ uid, mode, isFile: () => true })
  assert.equal(isPrivilegedExecutable(stat(0, 0o4755)), true)
  for (const [uid, mode] of [
    [501, 0o4755],
    [0, 0o2755],
    [0, 0o4655],
    [0, 0o4777]
  ]) {
    assert.equal(isPrivilegedExecutable(stat(uid, mode)), false)
  }
})

test('shell and AppleScript quoting keep spaces and metacharacters literal', () => {
  const value = '/tmp/a "quote" \\ slash \' apostrophe $(false) `false`'
  const quoted = quoteShellArg(value)
  assert.equal(
    execFileSync('/bin/sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' }),
    value
  )
  const script = `printf '%s' ${quoted}`
  const appleScript = toAppleScript(script)
  assert.equal(
    JSON.parse(
      appleScript.slice('do shell script '.length, -' with administrator privileges'.length)
    ),
    script
  )
})
