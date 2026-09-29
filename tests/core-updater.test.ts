import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadMainModule } from './helpers/load-main-module'

test('macOS core updates use the managed installer rather than self-overwriting the authorized copy', async () => {
  const events: string[] = []
  const module = loadMainModule(
    new URL('../src/main/core/mihomoApi.ts', import.meta.url),
    {
      axios: {
        create: () => ({
          interceptors: { response: { use: () => {} } },
          post: async () => events.push('self-overwrite')
        })
      },
      '../config': { getAppConfig: async () => ({ core: 'mihomo' }) },
      '..': {},
      '../resolve/tray': {},
      './factory': {},
      '../resolve/floatingWindow': {},
      '../utils/dirs': { mihomoIpcPath: () => '/fixture.sock' },
      './mac-core-updater': { upgradeMacCore: async () => events.push('managed-update') }
    },
    { process: { platform: 'darwin' } }
  )
  await module.mihomoUpgrade()
  assert.deepEqual(events, ['managed-update'])
})

import fs from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { installCoreUpdate, CoreUpdateInstallError } from '../src/main/core/core-update-install'

async function coreFixture() {
  const fixture = await mkdtemp(path.join(tmpdir(), 'koala-update-test-'))
  const bundled = path.join(fixture, 'extra/sidecar/mihomo')
  const directory = path.join(fixture, 'data/cores')
  const authorizedDir = path.join(fixture, 'authorized')
  await mkdir(path.dirname(bundled), { recursive: true })
  await mkdir(authorizedDir)
  await writeFile(bundled, 'old core')
  const nativePath = (file: string) =>
    file.startsWith('/Library/Application Support/Koala Clash/Cores/')
      ? path.join(authorizedDir, path.basename(file))
      : file
  const loadPaths = () => {
    const permissions = loadMainModule(
      new URL('../src/main/core/core-permissions.ts', import.meta.url),
      {
        'node:fs': {
          ...fs,
          readFileSync: (file: string) => fs.readFileSync(nativePath(file)),
          statSync: (file: string) => fs.statSync(nativePath(file)),
          lstatSync: (file: string) => {
            const stat = fs.lstatSync(nativePath(file))
            // OS permission boundary only; paths, hashes, and all core files remain real.
            if (file !== nativePath(file))
              return { ...stat, uid: 0, mode: 0o104755, isFile: () => true }
            return stat
          }
        }
      }
    )
    const dirs = loadMainModule(
      new URL('../src/main/utils/dirs.ts', import.meta.url),
      {
        electron: { app: { getPath: () => path.join(fixture, 'data') } },
        '@electron-toolkit/utils': { is: { dev: true } },
        '../config/app': {},
        '../core/manager': {},
        '../utils/i18n': {},
        './i18n': {},
        '../core/core-permissions': permissions
      },
      { process: { platform: 'darwin' }, __dirname: path.join(fixture, 'out/main') }
    )
    return { permissions, dirs }
  }
  const { permissions, dirs } = loadPaths()
  const authorize = async (staged: string) => {
    const previous = dirs.mihomoSourcePath('mihomo')
    await permissions.grantMacCorePermission(staged, {
      preserveSource: previous,
      runAdmin: async (script: string, temporary: string) => {
        assert.ok(script.includes(path.basename(permissions.getMacCoreInstallPath(previous))))
        await copyFile(temporary, nativePath(permissions.getMacCoreInstallPath(staged)))
      }
    })
  }
  await authorize(bundled)
  const archive = gzipSync(Buffer.from('new core'))
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`
  return { fixture, bundled, directory, nativePath, loadPaths, authorize, archive, digest, dirs }
}

test('a verified core remains selected and authorized after a fresh app startup', async () => {
  const f = await coreFixture()
  let restarts = 0
  try {
    await installCoreUpdate({
      core: 'mihomo',
      directory: f.directory,
      archive: f.archive,
      digest: f.digest,
      validate: async (staged) => {
        assert.equal(await readFile(staged, 'utf8'), 'new core')
      },
      authorize: f.authorize,
      restart: async () => {
        restarts++
        assert.equal(
          await readFile(f.nativePath(f.dirs.mihomoCorePath('mihomo')), 'utf8'),
          'new core'
        )
      },
      verify: async () => {}
    })
    const afterRelaunch = f.loadPaths()
    const selected = afterRelaunch.dirs.mihomoCorePath('mihomo')
    assert.ok(selected.startsWith('/Library/Application Support/Koala Clash/Cores/'))
    assert.equal(await readFile(f.nativePath(selected), 'utf8'), 'new core')
    assert.equal(await readFile(f.bundled, 'utf8'), 'old core')
    assert.equal(restarts, 1)
  } finally {
    await rm(f.fixture, { recursive: true, force: true })
  }
})

for (const hasPreviousUpdate of [false, true]) {
  test(`startup failure restores the ${hasPreviousUpdate ? 'previous update' : 'bundled core'} with authorization`, async () => {
    const f = await coreFixture()
    try {
      if (hasPreviousUpdate) {
        await mkdir(f.directory, { recursive: true })
        await writeFile(path.join(f.directory, 'mihomo'), 'previous update')
        await f.authorize(path.join(f.directory, 'mihomo'))
      }
      const original = f.dirs.mihomoCorePath('mihomo')
      let restarts = 0
      await assert.rejects(
        installCoreUpdate({
          core: 'mihomo',
          directory: f.directory,
          archive: f.archive,
          digest: f.digest,
          validate: async () => {},
          authorize: f.authorize,
          restart: async () => {
            if (++restarts === 1) throw new Error('new core cannot start')
            assert.equal(f.dirs.mihomoCorePath('mihomo'), original)
          },
          verify: async () => {}
        }),
        (error) => error instanceof CoreUpdateInstallError && error.rolledBack
      )
      assert.equal(f.loadPaths().dirs.mihomoCorePath('mihomo'), original)
      assert.equal(restarts, 2)
    } finally {
      await rm(f.fixture, { recursive: true, force: true })
    }
  })
}

for (const failure of ['checksum', 'cancel']) {
  test(`${failure} leaves the running core and its selected file unchanged`, async () => {
    const f = await coreFixture()
    try {
      const original = f.dirs.mihomoCorePath('mihomo')
      await assert.rejects(
        installCoreUpdate({
          core: 'mihomo',
          directory: f.directory,
          archive: f.archive,
          digest: failure === 'checksum' ? `sha256:${'0'.repeat(64)}` : f.digest,
          validate: async () => {},
          authorize: async () => {
            assert.equal(failure, 'cancel')
            throw new Error('User cancelled (-128)')
          },
          restart: async () => {
            assert.fail('failed preparation must not interrupt the core')
          },
          verify: async () => {}
        }),
        failure === 'checksum' ? /SHA-256/ : /cancelled/
      )
      assert.equal(f.dirs.mihomoCorePath('mihomo'), original)
    } finally {
      await rm(f.fixture, { recursive: true, force: true })
    }
  })
}

for (const channel of ['mihomo', 'mihomo-alpha']) {
  test(`${channel} downloads the official macOS asset and accepts real Mihomo Meta version output`, async () => {
    const f = await coreFixture()
    const version = channel === 'mihomo' ? 'v1.19.32' : 'alpha-abcdef0'
    const archiveUrl = `https://github.com/MetaCubeX/mihomo/releases/download/${channel === 'mihomo' ? version : 'Prerelease-Alpha'}/mihomo-darwin-arm64-${version}.gz`
    const calls: string[] = []
    let runningVersion = 'v1.19.31'
    const api = loadMainModule(
      new URL('../src/main/core/mac-core-updater.ts', import.meta.url),
      {
        axios: {
          get: async (url: string) => {
            calls.push(url)
            if (url.endsWith('/version.txt')) return { data: version + '\n' }
            if (url.endsWith('.gz')) {
              assert.equal(url, archiveUrl)
              return { data: f.archive }
            }
            assert.equal(
              url,
              `https://api.github.com/repos/MetaCubeX/mihomo/releases/${channel === 'mihomo' ? 'latest' : 'tags/Prerelease-Alpha'}`
            )
            return {
              data: {
                tag_name: channel === 'mihomo' ? version : 'Prerelease-Alpha',
                assets: [
                  {
                    name: 'version.txt',
                    browser_download_url:
                      'https://github.com/MetaCubeX/mihomo/releases/download/Prerelease-Alpha/version.txt'
                  },
                  {
                    name: `mihomo-darwin-arm64-${version}.gz`,
                    browser_download_url: archiveUrl,
                    digest: f.digest
                  }
                ]
              }
            }
          }
        },
        'node:child_process': {
          execFile: (
            _file: string,
            _args: string[],
            _options: unknown,
            callback: (error: Error | null, output: { stdout: string }) => void
          ) => callback(null, { stdout: `Mihomo Meta ${version} darwin arm64 with go1.26.8\n` })
        },
        '../config': { getAppConfig: async () => ({ core: channel }) },
        '../utils/dirs': {
          dataDir: () => path.join(f.fixture, 'data'),
          logPath: () => path.join(f.fixture, 'core.log'),
          mihomoCorePath: () => f.bundled,
          mihomoSourcePath: () => f.bundled
        },
        '../utils/i18n': { t: (key: string) => key },
        './factory': { getRuntimeConfig: async () => ({}) },
        './core-permissions': { hasCorePermission: () => false },
        './manager': {
          restartCore: async () => {
            runningVersion = version
          }
        },
        './mihomoApi': { mihomoVersion: async () => ({ version: runningVersion }) }
      },
      { process: { platform: 'darwin', arch: 'arm64' } }
    )
    try {
      await api.upgradeMacCore()
      assert.equal(await readFile(path.join(f.directory, channel), 'utf8'), 'new core')
      assert.equal(runningVersion, version)
      assert.equal(calls.at(-1), archiveUrl)
    } finally {
      await rm(f.fixture, { recursive: true, force: true })
    }
  })
}
