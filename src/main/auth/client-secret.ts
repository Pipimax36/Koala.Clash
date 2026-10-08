import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { AuthRequestError } from './contracts'

const PREFIX = 'koala-whmcs-client-v1:'
const MAX_BYTES = 16_384

interface SecretOptions {
  filePath: string
  environmentSecret?: string
  sourceFile?: string
  bundledSecret?: string
  crypto: {
    isAvailable(): boolean
    encrypt(value: string): Buffer
    decrypt(value: Buffer): string
  }
}

async function readPrivateFile(filePath: string): Promise<string> {
  const file = await open(filePath, 'r')
  try {
    const info = await file.stat()
    if (
      !info.isFile() ||
      info.size > MAX_BYTES ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    ) {
      throw new Error('Invalid local credential file')
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_BYTES) throw new Error('Invalid local credential file')
    return buffer.subarray(0, length).toString('utf8')
  } finally {
    await file.close()
  }
}

/** Application client credential, separate from user sessions and never exposed through renderer IPC. */
export function createClientSecretLoader(options: SecretOptions): () => Promise<string> {
  let cached: Promise<string> | undefined
  const load = async (): Promise<string> => {
    try {
      let secret: string
      const importing = options.environmentSecret !== undefined || options.sourceFile !== undefined
      if (options.environmentSecret !== undefined) {
        secret = options.environmentSecret.trim()
      } else if (options.sourceFile !== undefined) {
        if (!isAbsolute(options.sourceFile)) throw new Error('Absolute path required')
        secret = (await readPrivateFile(options.sourceFile)).trim()
      } else if (options.bundledSecret !== undefined) {
        // A newer build's credential takes precedence over an older encrypted
        // cache. The shared compiled value does not need another persisted copy.
        secret = options.bundledSecret.trim()
      } else {
        if (!options.crypto.isAvailable()) throw new Error('Encryption unavailable')
        const stored = await readPrivateFile(options.filePath)
        if (!stored.startsWith(PREFIX)) throw new Error('Invalid credential envelope')
        const encoded = stored.slice(PREFIX.length)
        const bytes = Buffer.from(encoded, 'base64')
        if (!encoded || bytes.toString('base64') !== encoded) throw new Error('Invalid encoding')
        secret = options.crypto.decrypt(bytes)
      }
      if (!/^[\x21-\x7e]{1,4096}$/.test(secret)) throw new Error('Invalid credential')
      if (importing && options.crypto.isAvailable()) {
        const encrypted = options.crypto.encrypt(secret)
        if (!encrypted.length || encrypted.length > 8192) throw new Error('Encryption failed')
        const directory = dirname(options.filePath)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await chmod(directory, 0o700)
        const temporary = join(directory, `.client-secret-${randomUUID()}.tmp`)
        try {
          const file = await open(temporary, 'wx', 0o600)
          try {
            await file.chmod(0o600)
            await file.writeFile(PREFIX + encrypted.toString('base64'))
            await file.sync()
          } finally {
            await file.close()
          }
          await rename(temporary, options.filePath)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      return secret
    } catch {
      throw new AuthRequestError('configuration-error')
    }
  }
  return () => {
    cached ??= load().catch((error) => {
      cached = undefined
      throw error
    })
    return cached
  }
}
