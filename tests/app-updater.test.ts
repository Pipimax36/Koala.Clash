import assert from 'node:assert/strict'
import { test } from 'node:test'
import YAML from 'yaml'
import { loadMainModule } from './helpers/load-main-module'

function updater(current: string, remote: string, status = 200) {
  const requests: string[] = []
  const api = loadMainModule(new URL('../src/main/resolve/autoUpdater.ts', import.meta.url), {
    axios: {
      get: async (url: string) => {
        requests.push(url)
        if (status !== 200) throw { response: { status }, isAxiosError: true }
        return {
          data: url.endsWith('.yml')
            ? YAML.stringify({ version: remote, changelog: 'Changes' })
            : { tag_name: remote, body: 'Changes', draft: false, prerelease: false }
        }
      },
      isAxiosError: (error: { isAxiosError?: boolean }) => error.isAxiosError
    },
    electron: { app: { getVersion: () => current } },
    '../core/factory': { getRuntimeConfig: async () => ({}) },
    '../utils/dirs': {},
    '..': {},
    '../sys/sysproxy': {},
    '../utils/i18n': { t: (key: string) => key }
  })
  return { api, requests }
}

test('checks this project release repository and preserves its exact v-prefixed tag', async () => {
  const { api, requests } = updater('1.4.1', 'v1.4.2')
  const latest = await api.checkUpdate()
  assert.equal(latest.version, 'v1.4.2')
  assert.equal(requests[0], 'https://api.github.com/repos/Pipimax36/Koala.Clash/releases/latest')
})

for (const remote of ['1.4.0', 'v1.4.1', '1.4.1+build.2']) {
  test(`does not offer ${remote} over installed 1.4.1`, async () => {
    assert.equal(await updater('1.4.1', remote).api.checkUpdate(), undefined)
  })
}

test('a repository without a published release has no update', async () => {
  assert.equal(await updater('1.4.1', '', 404).api.checkUpdate(), undefined)
})

test('network/rate-limit errors are not reported as already up to date', async () => {
  await assert.rejects(updater('1.4.1', '', 403).api.checkUpdate())
})

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { quoteShellArg } from '../src/main/core/core-permissions'
import * as fsPromises from 'node:fs/promises'

for (const scenario of [
  'installed',
  'corrupt',
  'installer failed',
  'app missing',
  'wrong version',
  'wrong identifier',
  'executable missing'
]) {
  test(`macOS update: ${scenario}`, async () => {
    const corrupt = scenario === 'corrupt'
    const dir = await mkdtemp(path.join(tmpdir(), "koala's app update "))
    const data = Buffer.from('fixture installer')
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
    const url =
      'https://github.com/Pipimax36/Koala.Clash/releases/download/v1.4.2/Koala.Clash_arm64.pkg'
    const requests: string[] = []
    let installed = false
    let proxyDisabled = false
    const lifecycle: string[] = []
    let relaunchOptions: { execPath: string; args: string[] } | undefined
    const installedExecutable = '/Applications/Koala Clash.app/Contents/MacOS/Koala Clash'
    const api = loadMainModule(
      new URL('../src/main/resolve/autoUpdater.ts', import.meta.url),
      {
        axios: {
          get: async (address: string) => {
            requests.push(address)
            if (address.includes('/tags/'))
              return {
                data: {
                  tag_name: 'v1.4.2',
                  draft: false,
                  prerelease: false,
                  assets: [{ name: 'Koala.Clash_arm64.pkg', digest, browser_download_url: url }]
                }
              }
            assert.equal(address, url)
            return { data: corrupt ? Buffer.from('corrupt') : data }
          },
          CancelToken: { source: () => ({ token: {}, cancel: () => {} }) },
          isCancel: () => false
        },
        electron: {
          app: {
            getVersion: () => '1.4.1',
            relaunch: (options: typeof relaunchOptions) => {
              relaunchOptions = options
              lifecycle.push('relaunch')
            },
            quit: () => lifecycle.push('quit')
          },
          shell: { openPath: async () => '' }
        },
        child_process: {
          execFile: (
            executable: string,
            args: string[],
            options: unknown,
            callback: (error: Error | null, output?: { stdout: string }) => void
          ) => {
            assert.equal(executable, '/usr/bin/plutil')
            assert.deepEqual(Array.from(args), [
              '-convert',
              'json',
              '-o',
              '-',
              '/Applications/Koala Clash.app/Contents/Info.plist'
            ])
            assert.equal(installed, true)
            lifecycle.push('verify bundle')
            if (scenario === 'app missing') return callback(new Error('ENOENT'))
            callback(null, {
              stdout: JSON.stringify({
                CFBundleIdentifier:
                  scenario === 'wrong identifier' ? 'other.app' : 'com.koala-clash',
                CFBundleShortVersionString: scenario === 'wrong version' ? '1.4.1' : '1.4.2'
              })
            })
          }
        },
        'fs/promises': {
          ...fsPromises,
          access: async (file: string) => {
            assert.equal(file, installedExecutable)
            if (scenario === 'executable missing') throw new Error('ENOENT')
          }
        },
        '../core/factory': { getRuntimeConfig: async () => ({}) },
        '../utils/dirs': { dataDir: () => dir, isPortable: () => false },
        '..': { setNotQuitDialog: () => lifecycle.push('allow quit') },
        '../sys/sysproxy': {
          disableSysProxy: () => {
            proxyDisabled = true
          }
        },
        '../utils/i18n': { t: (key: string) => key },
        '../core/core-permissions': {
          quoteShellArg,
          runMacAdminScript: async (script: string) => {
            const file = path.join(dir, 'updates/v1.4.2/Koala.Clash_arm64.pkg')
            assert.equal(await readFile(file, 'utf8'), data.toString())
            assert.equal(script, `/usr/sbin/installer -pkg ${quoteShellArg(file)} -target /`)
            if (scenario === 'installer failed') throw new Error('installer failed')
            installed = true
          }
        }
      },
      { process: { platform: 'darwin', arch: 'arm64' } }
    )
    try {
      if (corrupt)
        await assert.rejects(api.downloadAndInstallUpdate('v1.4.2'), /sha256VerificationFailed/)
      else if (scenario === 'installer failed')
        await assert.rejects(api.downloadAndInstallUpdate('v1.4.2'), /installer failed/)
      else if (scenario !== 'installed')
        await assert.rejects(api.downloadAndInstallUpdate('v1.4.2'), /macInstallVerificationFailed/)
      else {
        await api.downloadAndInstallUpdate('v1.4.2')
        assert.equal(relaunchOptions?.execPath, installedExecutable)
        assert.deepEqual(Array.from(relaunchOptions?.args ?? ['unexpected']), [])
        assert.deepEqual(lifecycle, ['verify bundle', 'relaunch', 'allow quit', 'quit'])
      }
      assert.equal(
        requests[0],
        'https://api.github.com/repos/Pipimax36/Koala.Clash/releases/tags/v1.4.2'
      )
      assert.equal(installed, !corrupt && scenario !== 'installer failed')
      assert.equal(proxyDisabled, !corrupt)
      if (scenario !== 'installed') {
        assert.equal(lifecycle.includes('relaunch'), false)
        assert.equal(lifecycle.includes('quit'), false)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}
