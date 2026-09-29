import axios, { AxiosRequestConfig, CancelTokenSource } from 'axios'
import { gt, valid } from 'semver'
import { appReleasesApi } from '../../shared/app-update'
import { app, shell } from 'electron'
import { getRuntimeConfig } from '../core/factory'
import { dataDir, exeDir, exePath, isPortable, resourcesFilesDir } from '../utils/dirs'
import { copyFile, rm, writeFile, readFile, mkdir } from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { setNotQuitDialog, mainWindow } from '..'
import { disableSysProxy } from '../sys/sysproxy'
import { t } from '../utils/i18n'
import { quoteShellArg, runMacAdminScript } from '../core/core-permissions'

let downloadCancelToken: CancelTokenSource | null = null

interface AppRelease {
  tag_name: string
  body: string | null
  draft: boolean
  prerelease: boolean
  assets: Array<{ name: string; digest?: string; browser_download_url: string }>
}

export async function checkUpdate(): Promise<AppVersion | undefined> {
  const { 'mixed-port': mixedPort = 0 } = (await getRuntimeConfig()) ?? {}
  let release: AppRelease
  try {
    const res = await axios.get<AppRelease>(`${appReleasesApi}/latest`, {
      timeout: 15000,
      headers: { Accept: 'application/vnd.github+json' },
      ...(mixedPort != 0 && {
        proxy: {
          protocol: 'http',
          host: '127.0.0.1',
          port: mixedPort
        }
      })
    })
    release = res.data
  } catch (error) {
    // A new repository may not have its first public release yet.
    if (axios.isAxiosError(error) && error.response?.status === 404) return undefined
    throw error
  }
  const currentVersion = app.getVersion()
  if (!valid(release.tag_name) || !valid(currentVersion)) {
    throw new Error(t('error.invalidUpdateVersion'))
  }
  if (release.draft || release.prerelease || !gt(release.tag_name, currentVersion)) return undefined
  // Keep the real tag: v1.4.2 and 1.4.2 are equal versions but different release URLs.
  return { version: release.tag_name, changelog: release.body || '' }
}

export async function downloadAndInstallUpdate(version: string): Promise<void> {
  if (downloadCancelToken) throw new Error(t('error.updateInProgress'))
  if (!valid(version) || !gt(version, app.getVersion())) {
    throw new Error(t('error.invalidUpdateVersion'))
  }
  const { 'mixed-port': mixedPort = 0 } = (await getRuntimeConfig()) ?? {}
  const releaseTag = version
  const fileMap = {
    'win32-x64': `Koala.Clash_x64-setup.exe`,
    'win32-arm64': `Koala.Clash_arm64-setup.exe`,
    'darwin-x64': `Koala.Clash_x64.pkg`,
    'darwin-arm64': `Koala.Clash_arm64.pkg`
  }
  let file = fileMap[`${process.platform}-${process.arch}`]
  if (!file) {
    throw new Error(t('error.autoUpdateNotSupported'))
  }
  if (isPortable()) file = file.replace('-setup.exe', '-portable.7z')
  const updateDir = path.join(dataDir(), 'updates', encodeURIComponent(releaseTag))
  const downloadedFile = path.join(updateDir, file)
  if (downloadCancelToken) throw new Error(t('error.updateInProgress'))
  downloadCancelToken = axios.CancelToken.source()

  const apiUrl = `${appReleasesApi}/tags/${encodeURIComponent(releaseTag)}`
  const apiRequestConfig: AxiosRequestConfig = {
    timeout: 15000,
    headers: { Accept: 'application/vnd.github+json' },
    ...(mixedPort != 0 && {
      proxy: {
        protocol: 'http',
        host: '127.0.0.1',
        port: mixedPort
      }
    }),
    cancelToken: downloadCancelToken.token
  }

  try {
    await mkdir(updateDir, { recursive: true })
    mainWindow?.webContents.send('update-status', {
      downloading: true,
      progress: 0
    })
    mainWindow?.setProgressBar(0)

    const releaseRes = await axios.get<AppRelease>(apiUrl, apiRequestConfig)
    if (
      releaseRes.data.draft ||
      releaseRes.data.prerelease ||
      releaseRes.data.tag_name !== releaseTag
    ) {
      throw new Error(t('error.invalidUpdateVersion'))
    }
    const assets = releaseRes.data.assets || []
    const matchedAsset = assets.find((a) => a.name === file)
    if (!matchedAsset || !/^sha256:[a-f0-9]{64}$/i.test(matchedAsset.digest || '')) {
      throw new Error(`${t('error.sha256NotFound')}: "${file}"`)
    }
    const expectedHash = matchedAsset.digest!.split(':')[1].toLowerCase()

    if (existsSync(downloadedFile)) {
      const cachedHash = createHash('sha256')
        .update(await readFile(downloadedFile))
        .digest('hex')
      if (cachedHash !== expectedHash) await rm(downloadedFile, { force: true })
    }
    if (!existsSync(downloadedFile)) {
      const res = await axios.get(matchedAsset.browser_download_url, {
        timeout: 120000,
        responseType: 'arraybuffer',
        ...(mixedPort != 0 && {
          proxy: {
            protocol: 'http',
            host: '127.0.0.1',
            port: mixedPort
          }
        }),
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        cancelToken: downloadCancelToken.token,
        onDownloadProgress: (progressEvent) => {
          const percentCompleted = Math.round(
            (progressEvent.loaded * 100) / (progressEvent.total || 1)
          )
          mainWindow?.webContents.send('update-status', {
            downloading: true,
            progress: percentCompleted
          })
          mainWindow?.setProgressBar(percentCompleted / 100)
        }
      })
      await writeFile(downloadedFile, res.data)
    }

    const fileBuffer = await readFile(downloadedFile)
    const hashSum = createHash('sha256')
    hashSum.update(fileBuffer)
    const localHash = hashSum.digest('hex').toLowerCase()
    if (localHash !== expectedHash) {
      await rm(downloadedFile, { force: true })
      throw new Error(
        `${t('error.sha256VerificationFailed')}：${t('error.localHash')} ${localHash} ${t('error.expectedHash')} ${expectedHash} ${t('error.mismatch')}`
      )
    }

    mainWindow?.webContents.send('update-status', {
      downloading: false,
      progress: 100
    })
    mainWindow?.setProgressBar(-1)

    disableSysProxy(false)
    if (file.endsWith('.exe')) {
      spawn(downloadedFile, ['/S', '--force-run'], {
        detached: true,
        stdio: 'ignore'
      }).unref()
    }
    if (file.endsWith('.7z')) {
      await copyFile(path.join(resourcesFilesDir(), '7za.exe'), path.join(dataDir(), '7za.exe'))
      spawn(
        'cmd',
        [
          '/C',
          `"timeout /t 2 /nobreak >nul && "${path.join(dataDir(), '7za.exe')}" x -o"${exeDir()}" -y "${downloadedFile}" & start "" "${exePath()}""`
        ],
        {
          shell: true,
          detached: true
        }
      ).unref()
      setNotQuitDialog()
      app.quit()
    }
    if (file.endsWith('.pkg')) {
      try {
        await runMacAdminScript(
          `/usr/sbin/installer -pkg ${quoteShellArg(downloadedFile)} -target /`
        )
        app.relaunch()
        setNotQuitDialog()
        app.quit()
      } catch {
        await shell.openPath(downloadedFile)
      }
    }
  } catch (e) {
    await rm(downloadedFile, { force: true })
    mainWindow?.setProgressBar(-1)
    if (axios.isCancel(e)) {
      mainWindow?.webContents.send('update-status', {
        downloading: false,
        progress: 0,
        error: t('error.downloadCancelled')
      })
      return
    } else {
      mainWindow?.webContents.send('update-status', {
        downloading: false,
        progress: 0,
        error: e instanceof Error ? e.message : t('error.downloadFailed')
      })
    }
    throw e
  } finally {
    downloadCancelToken = null
  }
}

export async function cancelUpdate(): Promise<void> {
  if (downloadCancelToken) {
    downloadCancelToken.cancel(t('error.userCancelledDownload'))
  }
}
