import axios from 'axios'
import { execFile } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { getAppConfig } from '../config'
import { dataDir, logPath, mihomoCorePath, mihomoSourcePath } from '../utils/dirs'
import { t } from '../utils/i18n'
import { getRuntimeConfig } from './factory'
import { grantMacCorePermission, hasCorePermission } from './core-permissions'
import { CoreUpdateInstallError, installCoreUpdate } from './core-update-install'
import { restartCore } from './manager'
import { mihomoVersion } from './mihomoApi'

interface CoreRelease {
  tag_name: string
  assets: Array<{ name: string; digest?: string; browser_download_url: string }>
}

let updating = false

export async function upgradeMacCore(): Promise<void> {
  if (updating) throw new Error(t('error.updateInProgress'))
  updating = true
  try {
    const { core = 'mihomo' } = await getAppConfig()
    if (core !== 'mihomo' && core !== 'mihomo-alpha') {
      throw new Error(t('error.autoUpdateNotSupported'))
    }
    const source = mihomoSourcePath(core)
    const authorized = hasCorePermission(mihomoCorePath(core))
    const { 'mixed-port': port = 0 } = (await getRuntimeConfig()) ?? {}
    const config = {
      timeout: 15000,
      ...(port !== 0 && { proxy: { protocol: 'http', host: '127.0.0.1', port } })
    }
    const channel = core === 'mihomo-alpha' ? 'tags/Prerelease-Alpha' : 'latest'
    const { data: release } = await axios.get<CoreRelease>(
      `https://api.github.com/repos/MetaCubeX/mihomo/releases/${channel}`,
      { ...config, headers: { Accept: 'application/vnd.github+json' } }
    )
    let version = release.tag_name
    if (core === 'mihomo-alpha') {
      const versionFile = release.assets.find((asset) => asset.name === 'version.txt')
      if (!versionFile) throw new Error(t('error.invalidUpdateVersion'))
      const response = await axios.get<string>(versionFile.browser_download_url, {
        ...config,
        responseType: 'text'
      })
      version = response.data.trim()
    }
    if (!/^(?:v?\d+\.\d+\.\d+|alpha-[a-zA-Z0-9.-]+)$/.test(version)) {
      throw new Error(t('error.invalidUpdateVersion'))
    }
    if ((await mihomoVersion()).version === version) return
    const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64-v1' : ''
    if (!arch) throw new Error(t('error.autoUpdateNotSupported'))
    const asset = release.assets.find(
      (asset) => asset.name === `mihomo-darwin-${arch}-${version}.gz`
    )
    if (!asset?.digest || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) {
      throw new Error(t('error.sha256NotFound'))
    }
    const { data } = await axios.get<ArrayBuffer>(asset.browser_download_url, {
      ...config,
      timeout: 120000,
      maxContentLength: 64 * 1024 * 1024,
      responseType: 'arraybuffer'
    })
    const ensureSelected = async (): Promise<void> => {
      if (((await getAppConfig()).core || 'mihomo') !== core) {
        throw new Error(t('error.coreChangedDuringUpdate'))
      }
    }
    await installCoreUpdate({
      core,
      directory: path.join(dataDir(), 'cores'),
      archive: Buffer.from(data),
      digest: asset.digest,
      validate: async (staged) => {
        await ensureSelected()
        const { stdout } = await promisify(execFile)(staged, ['-v'], { timeout: 10000 })
        if (stdout.match(/^Mihomo(?: Meta)?\s+(\S+)/)?.[1] !== version) {
          throw new Error(t('error.coreVersionMismatch'))
        }
      },
      authorize: authorized
        ? async (staged) => {
            await grantMacCorePermission(staged, { preserveSource: source })
            await ensureSelected()
          }
        : undefined,
      restart: () => restartCore(true),
      verify: async () => {
        if ((await mihomoVersion()).version !== version) {
          throw new Error(t('error.coreVersionMismatch'))
        }
      }
    })
  } catch (error) {
    await appendFile(
      logPath(),
      `[Updater]: ${String(error)}; cause: ${String(error instanceof Error ? error.cause : '')}\n`
    ).catch(() => {})
    if (error instanceof CoreUpdateInstallError) {
      throw new Error(
        t(error.rolledBack ? 'error.coreUpdateFailed' : 'error.coreUpdateRollbackFailed'),
        { cause: error }
      )
    }
    if (String(error).includes('-128')) throw new Error(t('tray.userCancelled'))
    throw error
  } finally {
    updating = false
  }
}
