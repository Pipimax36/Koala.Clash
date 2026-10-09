import { servicePath } from '../utils/dirs'
import { execWithElevation } from '../utils/elevation'
import { t } from '../utils/i18n'
import { KeyManager } from './key'
import { initServiceAPI, getServiceAxios, ping, test } from './api'
import { getAppConfigSecret, patchAppConfig } from '../config/app'
import { createPublicKey } from 'node:crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'

let keyManager: KeyManager | null = null
let keyInitialization: Promise<KeyManager> | null = null
let serviceInitialization: Promise<KeyManager> | null = null

export async function initKeyManager(): Promise<KeyManager> {
  if (serviceInitialization) return serviceInitialization
  if (keyInitialization) return keyInitialization
  if (keyManager) return keyManager

  const pending = (async (): Promise<KeyManager> => {
    const storedKey = await getAppConfigSecret('serviceAuthKey')
    const candidate = new KeyManager()
    if (storedKey) {
      const parts = storedKey.split(':')
      const [publicKey, privateKey] = parts
      if (parts.length !== 2 || !publicKey || !privateKey) {
        throw new Error('Invalid stored helper service key')
      }
      const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
      if (derived.toString('base64') !== publicKey) {
        throw new Error('Invalid stored helper service key')
      }
      candidate.setKeyPair(publicKey, privateKey)
    } else {
      const pair = candidate.generateKeyPair()
      await patchAppConfig({ serviceAuthKey: `${pair.publicKey}:${pair.privateKey}` })
    }
    initServiceAPI(candidate)
    keyManager = candidate
    return candidate
  })()
  keyInitialization = pending
  try {
    return await pending
  } finally {
    if (keyInitialization === pending) keyInitialization = null
  }
}

export function getKeyManager(): KeyManager {
  if (!keyManager) {
    throw new Error(t('error.keyManagerNotInitializedHint'))
  }
  return keyManager
}

export async function getPublicKey(): Promise<string> {
  return (await initKeyManager()).getPublicKey()
}

class UserCancelledError extends Error {
  constructor(message = t('error.userCancelled')) {
    super(message)
    this.name = 'UserCancelledError'
  }
}

function isUserCancelledError(error: unknown): boolean {
  if (error instanceof UserCancelledError) {
    return true
  }
  const errorMsg = error instanceof Error ? error.message : String(error)
  return (
    errorMsg.includes(t('error.userCancelledCheck')) ||
    errorMsg.includes('User canceled') ||
    errorMsg.includes('(-128)') ||
    errorMsg.includes('user cancelled') ||
    errorMsg.includes('dismissed')
  )
}

export function exportPublicKey(): Promise<string> {
  return getPublicKey()
}

export function getAxios() {
  return getServiceAxios()
}

export async function initService(): Promise<void> {
  if (serviceInitialization) {
    await serviceInitialization
    return
  }
  // Prepare and persist the key before changing the helper's authorization.
  // Reuse a valid existing key so cancelled initialization cannot desynchronize it.
  const preparation = initKeyManager()
  const pending = (async (): Promise<KeyManager> => {
    try {
      const candidate = await preparation
      await execWithElevation(servicePath(), ['service', 'init', '--public-key', candidate.getPublicKey()])
      await new Promise((resolve) => setTimeout(resolve, 500))
      return candidate
    } catch (error) {
      if (isUserCancelledError(error)) throw new UserCancelledError()
      throw new Error(`${t('error.serviceInitFailed')}：${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  serviceInitialization = pending
  try {
    await pending
  } finally {
    if (serviceInitialization === pending) serviceInitialization = null
  }
}

export async function installService(): Promise<void> {
  const execPath = servicePath()

  try {
    await execWithElevation(execPath, ['service', 'install'])
  } catch (error) {
    if (isUserCancelledError(error)) {
      throw new UserCancelledError()
    }
    throw new Error(`${t('error.serviceInstallFailed')}：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function uninstallService(): Promise<void> {
  const execPath = servicePath()

  try {
    await execWithElevation(execPath, ['service', 'uninstall'])
  } catch (error) {
    if (isUserCancelledError(error)) {
      throw new UserCancelledError()
    }
    throw new Error(`${t('error.serviceUninstallFailed')}：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function startService(): Promise<void> {
  const execPath = servicePath()

  try {
    await execWithElevation(execPath, ['service', 'start'])
  } catch (error) {
    if (isUserCancelledError(error)) {
      throw new UserCancelledError()
    }
    throw new Error(`${t('error.serviceStartFailed')}：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function stopService(): Promise<void> {
  const execPath = servicePath()

  try {
    await execWithElevation(execPath, ['service', 'stop'])
  } catch (error) {
    if (isUserCancelledError(error)) {
      throw new UserCancelledError()
    }
    throw new Error(`${t('error.serviceStopFailed')}：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function restartService(): Promise<void> {
  const execPath = servicePath()

  try {
    await execWithElevation(execPath, ['service', 'restart'])
  } catch (error) {
    if (isUserCancelledError(error)) {
      throw new UserCancelledError()
    }
    throw new Error(`${t('error.serviceRestartFailed')}：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function serviceStatus(): Promise<
  'running' | 'stopped' | 'not-installed' | 'paused' | 'unknown' | 'need-init'
> {
  const execPath = servicePath()
  const execFilePromise = promisify(execFile)

  try {
    const { stderr } = await execFilePromise(execPath, ['service', 'status'])
    if (stderr.includes('the service is not installed')) {
      return 'not-installed'
    } else {
      try {
        await ping()
        try {
          const out = await test()
          if (out && typeof out === 'object' && 'status' in out && out.status === 'error') {
            return 'need-init'
          }
          return 'running'
        } catch (e) {
          return 'need-init'
        }
      } catch (e) {
        return 'stopped'
      }
    }
  } catch (error) {
    return 'unknown'
  }
}

export async function testServiceConnection(): Promise<boolean> {
  try {
    const out = await test()
    return !(out && typeof out === 'object' && 'status' in out && out.status === 'error');

  } catch {
    return false
  }
}
