import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { resolve } from 'node:path'

const MAX_FILE_BYTES = 16 * 1024
const DEFAULT_FILE = '.secrets/whmcs-client-secret.txt'
const INVALID_VALUE =
  'WHMCS login build secret is invalid. Use 1–4096 printable ASCII characters without spaces.'
const INVALID_FILE =
  'WHMCS login build secret file is unavailable or unsafe. Use a readable regular file of at most 16 KiB with POSIX mode 0600.'
const REQUIRED_SECRET =
  'WHMCS login is required for this build. Set KOALA_WHMCS_CLIENT_SECRET or supply .secrets/whmcs-client-secret.txt.'

interface BuildSecretOptions {
  root: string
  env?: Record<string, string | undefined>
}

function secretValue(value: string): string {
  const trimmed = value.trim()
  if (!/^[\x21-\x7e]{1,4096}$/.test(trimmed)) throw new Error(INVALID_VALUE)
  return trimmed
}

/** Called only by the build configuration. Importing this module performs no filesystem reads. */
export function resolveBundledWhmcsSecret(options: BuildSecretOptions): string | undefined {
  const env = options.env ?? process.env
  const required = env.KOALA_REQUIRE_WHMCS_LOGIN === '1'
  const missing = (): undefined => {
    if (required) throw new Error(REQUIRED_SECRET)
    return undefined
  }

  if (env.KOALA_WHMCS_CLIENT_SECRET !== undefined) {
    if (typeof env.KOALA_WHMCS_CLIENT_SECRET !== 'string') throw new Error(INVALID_VALUE)
    return secretValue(env.KOALA_WHMCS_CLIENT_SECRET)
  }

  const explicit = env.KOALA_WHMCS_CLIENT_SECRET_FILE !== undefined
  const fileSetting = env.KOALA_WHMCS_CLIENT_SECRET_FILE
  if (explicit && (typeof fileSetting !== 'string' || !fileSetting.trim())) {
    throw new Error(INVALID_FILE)
  }

  let descriptor: number | undefined
  let content: string
  let mode: number
  try {
    const path = resolve(options.root, explicit ? fileSetting!.trim() : DEFAULT_FILE)
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(INVALID_FILE)
    // O_NOFOLLOW closes the final-component symlink race after lstat. O_NONBLOCK
    // prevents a substituted FIFO from blocking before fstat verifies the opened file.
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(INVALID_FILE)
    mode = stat.mode
    // Read from the verified descriptor with a hard bound even if the file grows.
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
    let total = 0
    while (total < bytes.length) {
      const read = readSync(descriptor, bytes, total, bytes.length - total, null)
      if (read === 0) break
      total += read
    }
    if (total > MAX_FILE_BYTES) throw new Error(INVALID_FILE)
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total))
  } catch (error) {
    if (!explicit && (error as NodeJS.ErrnoException).code === 'ENOENT') return missing()
    // Filesystem errors include paths. Never forward them, their cause, or file contents.
    throw new Error(INVALID_FILE)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }

  if (!explicit && !content.trim()) return missing()
  if (process.platform !== 'win32' && (mode & 0o7777 & ~0o600) !== 0) {
    throw new Error(INVALID_FILE)
  }
  return secretValue(content)
}
