import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { isIdentityToken, type AuthVault } from './contracts'

const PREFIX = 'koala-auth-v2:'
const MAX_BYTES = 64 * 1024

interface VaultCrypto {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value)
}

function isExpiry(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function assertVault(value: unknown): asserts value is AuthVault {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    Object.keys(value).some((key) => !['version', 'pending', 'session'].includes(key)) ||
    (value.pending !== undefined && value.session !== undefined)
  ) {
    throw new Error('Invalid authentication vault')
  }
  const { pending, session } = value
  if (
    pending !== undefined &&
    (!isRecord(pending) ||
      !isNonce(pending.state) ||
      !isNonce(pending.codeVerifier) ||
      !isNonce(pending.nonce) ||
      !isExpiry(pending.expiresAt) ||
      Object.keys(pending).some(
        (key) => !['state', 'codeVerifier', 'nonce', 'expiresAt'].includes(key)
      ))
  ) {
    throw new Error('Invalid authentication vault')
  }
  if (
    session !== undefined &&
    (!isRecord(session) ||
      typeof session.accessToken !== 'string' ||
      session.accessToken.length > 8192 ||
      !/^[\x21-\x7e]+$/.test(session.accessToken) ||
      (session.idToken !== undefined && !isIdentityToken(session.idToken)) ||
      !isExpiry(session.expiresAt) ||
      !isRecord(session.user) ||
      typeof session.user.id !== 'string' ||
      !session.user.id ||
      session.user.id.length > 1024 ||
      (session.user.name !== undefined &&
        (typeof session.user.name !== 'string' || session.user.name.length > 256)) ||
      (session.user.email !== undefined &&
        (typeof session.user.email !== 'string' || session.user.email.length > 320)) ||
      Object.keys(session.user).some((key) => !['id', 'name', 'email'].includes(key)) ||
      Object.keys(session).some(
        (key) => !['accessToken', 'idToken', 'expiresAt', 'user'].includes(key)
      ))
  ) {
    throw new Error('Invalid authentication vault')
  }
}

async function readBounded(filePath: string): Promise<string> {
  const file = await open(filePath, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_BYTES) {
      throw new Error('Invalid authentication vault size')
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_BYTES) throw new Error('Invalid authentication vault size')
    return buffer.subarray(0, length).toString('utf8')
  } finally {
    await file.close()
  }
}

export function createSecureAuthStore(
  filePath: string,
  crypto: VaultCrypto
): {
  load(): Promise<AuthVault | null>
  save(vault: AuthVault): Promise<boolean>
} {
  const store = {
    async load(): Promise<AuthVault | null> {
      let stored: string
      try {
        stored = await readBounded(filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      if (!stored.startsWith(PREFIX) || !crypto.isAvailable()) {
        throw new Error('Secure authentication storage cannot be read')
      }
      const encoded = stored.slice(PREFIX.length)
      const encrypted = Buffer.from(encoded, 'base64')
      if (!encoded || encrypted.toString('base64') !== encoded) {
        throw new Error('Invalid authentication vault encoding')
      }
      let vault: unknown
      try {
        const plaintext = crypto.decrypt(encrypted)
        if (Buffer.byteLength(plaintext, 'utf8') > MAX_BYTES) {
          throw new Error('Invalid authentication vault size')
        }
        vault = JSON.parse(plaintext)
      } catch {
        throw new Error('Authentication vault could not be decrypted')
      }
      assertVault(vault)
      return vault
    },
    async save(vault: AuthVault): Promise<boolean> {
      assertVault(vault)
      if (!crypto.isAvailable()) {
        await rm(filePath, { force: true })
        return false
      }
      if (!vault.pending && !vault.session) {
        await rm(filePath, { force: true })
        return true
      }
      const plaintext = JSON.stringify(vault)
      if (Buffer.byteLength(plaintext, 'utf8') > MAX_BYTES) {
        throw new Error('Invalid authentication vault size')
      }
      let stored: string
      try {
        const encrypted = crypto.encrypt(plaintext)
        if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
          throw new Error('Empty encrypted vault')
        }
        stored = PREFIX + encrypted.toString('base64')
        if (Buffer.byteLength(stored, 'utf8') > MAX_BYTES) {
          throw new Error('Invalid authentication vault size')
        }
      } catch {
        await rm(filePath, { force: true })
        return false
      }
      const directory = path.dirname(filePath)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
      try {
        const file = await open(temporary, 'wx', 0o600)
        try {
          await file.chmod(0o600)
          await file.writeFile(stored, 'utf8')
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temporary, filePath)
      } finally {
        await rm(temporary, { force: true })
      }
      return true
    }
  }
  let queued: Promise<void> = Promise.resolve()
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queued.then(operation)
    queued = result.then(
      () => {},
      () => {}
    )
    return result
  }

  return {
    load: () => enqueue(() => store.load()),
    save: async (vault) => {
      const snapshot = structuredClone(vault)
      return enqueue(() => store.save(snapshot))
    }
  }
}
