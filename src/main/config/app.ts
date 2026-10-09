import { readFile, writeFile, rename, copyFile, unlink } from 'fs/promises'
import { appConfigPath } from '../utils/dirs'
import { parseYaml, stringifyYaml } from '../utils/yaml'
import { deepMerge } from '../utils/merge'
import { defaultConfig } from '../utils/template'
import { readFileSync, existsSync } from 'fs'
import { encryptString, decryptString } from '../utils/encrypt'

let appConfig: AppConfig
let writePromise: Promise<void> = Promise.resolve()
let loadPromise: Promise<AppConfig> | undefined

const ENCRYPTED_FIELDS = ['systemCorePath', 'serviceAuthKey'] as const
type EncryptedField = (typeof ENCRYPTED_FIELDS)[number]
let encryptedValues: Partial<Record<EncryptedField, string>> = {}
const decryptedValues = new Map<EncryptedField, { encrypted: string; plain: string }>()

function isValidConfig(config: unknown): config is AppConfig {
  if (!config || typeof config !== 'object') return false
  const cfg = config as Partial<AppConfig>
  return 'sysProxy' in cfg && typeof cfg.sysProxy === 'object' && cfg.sysProxy !== null
}

async function safeWriteConfig(content: string): Promise<void> {
  const configPath = appConfigPath()
  const tmpPath = `${configPath}.tmp`
  const backupPath = `${configPath}.backup`

  try {
    await writeFile(tmpPath, content, 'utf-8')
    if (existsSync(configPath)) {
      await copyFile(configPath, backupPath)
      if (process.platform === 'win32') {
        await unlink(configPath)
      }
    }
    if (existsSync(tmpPath)) {
      await rename(tmpPath, configPath)
    }
  } catch (e) {
    if (existsSync(tmpPath)) {
      try {
        await unlink(tmpPath)
      } catch {
        // ignore
      }
    }
    throw e
  }
}

function publicConfig(config: AppConfig): AppConfig {
  const result = { ...config }
  for (const field of ENCRYPTED_FIELDS) {
    delete result[field]
  }
  return result
}

function decryptField(field: EncryptedField, encrypted?: string): string {
  if (!encrypted) return ''
  const cached = decryptedValues.get(field)
  if (cached?.encrypted === encrypted) return cached.plain
  // Never cache failures or replace stored ciphertext when Keychain access is denied.
  const plain = decryptString(encrypted)
  decryptedValues.set(field, { encrypted, plain })
  return plain
}

async function loadConfig(force = false): Promise<AppConfig> {
  if (loadPromise) return loadPromise
  if (!force && appConfig) return appConfig
  loadPromise = (async () => {
    let loaded = defaultConfig
    try {
      const data = await readFile(appConfigPath(), 'utf-8')
      const parsed = parseYaml<AppConfig>(data)
      if (!isValidConfig(parsed)) throw new Error('Invalid app configuration')
      loaded = parsed
    } catch {
      try {
        const backup = parseYaml<AppConfig>(await readFile(`${appConfigPath()}.backup`, 'utf-8'))
        if (isValidConfig(backup)) loaded = backup
      } catch {
        // A new installation has neither a configuration nor a backup.
      }
    }
    encryptedValues = {}
    for (const field of ENCRYPTED_FIELDS) {
      if (typeof loaded[field] === 'string') encryptedValues[field] = loaded[field]
    }
    appConfig = publicConfig(loaded)
    return appConfig
  })()
  try {
    return await loadPromise
  } finally {
    loadPromise = undefined
  }
}

export function getAppConfig(force = false): Promise<AppConfig> {
  if (!force) return loadConfig()
  // A disk snapshot must not arrive after a newer settings write and replace its secrets.
  const reload = writePromise.then(() => loadConfig(true))
  writePromise = reload.then(
    () => undefined,
    () => undefined
  )
  return reload
}

// Only the feature that actually needs a protected value should call these accessors.
export async function getAppConfigSecret(field: EncryptedField): Promise<string> {
  await writePromise
  await getAppConfig()
  return decryptField(field, encryptedValues[field])
}

export function getAppConfigSecretSync(field: EncryptedField): string {
  let config: AppConfig
  try {
    config = parseYaml<AppConfig>(readFileSync(appConfigPath(), 'utf-8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
  return decryptField(field, config?.[field])
}

export async function patchAppConfig(
  patch: Partial<AppConfig>,
  shouldApply?: (current: Readonly<AppConfig>) => boolean
): Promise<void> {
  const previousPromise = writePromise
  const write = (async () => {
    await previousPromise
    await loadConfig()
    if (shouldApply && !shouldApply(appConfig)) return
    const nextEncryptedValues = { ...encryptedValues }
    const publicPatch = { ...patch }
    for (const field of ENCRYPTED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        const value = patch[field]
        nextEncryptedValues[field] = value ? encryptString(value) : ''
      }
      delete publicPatch[field]
    }
    // Keep both the live configuration and ciphertext unchanged if encryption or I/O fails.
    const nextConfig = deepMerge(deepMerge({} as AppConfig, appConfig), publicPatch)
    await safeWriteConfig(stringifyYaml({ ...nextConfig, ...nextEncryptedValues }))
    appConfig = nextConfig
    encryptedValues = nextEncryptedValues
  })()
  // A refused Keychain request must not block subsequent ordinary settings writes.
  writePromise = write.catch(() => undefined)
  await write
}

export function getAppConfigSync(): AppConfig {
  try {
    const raw = readFileSync(appConfigPath(), 'utf-8')
    const data = parseYaml<AppConfig>(raw)
    if (typeof data === 'object' && data !== null) {
      return publicConfig(data)
    }
    return defaultConfig
  } catch (e) {
    return defaultConfig
  }
}
