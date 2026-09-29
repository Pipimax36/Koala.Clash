import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

interface InstallOptions {
  core: 'mihomo' | 'mihomo-alpha'
  directory: string
  archive: Buffer
  digest: string
  validate: (staged: string) => Promise<void>
  authorize?: (staged: string) => Promise<void>
  restart: () => Promise<void>
  verify: () => Promise<void>
}

export class CoreUpdateInstallError extends Error {
  constructor(
    readonly rolledBack: boolean,
    cause: unknown
  ) {
    super(rolledBack ? 'Core update rolled back' : 'Core update rollback failed', { cause })
  }
}

// The old executable stays selected until validation and authorization both succeed.
export async function installCoreUpdate(options: InstallOptions): Promise<void> {
  const { core, directory, archive, digest, validate, authorize, restart, verify } = options
  if (
    !/^sha256:[a-f0-9]{64}$/i.test(digest) ||
    createHash('sha256').update(archive).digest('hex') !== digest.slice(7).toLowerCase()
  ) {
    throw new Error('Core download SHA-256 verification failed')
  }
  const binary = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 })
  await mkdir(directory, { recursive: true })
  const staging = await mkdtemp(path.join(directory, '.update-'))
  const staged = path.join(staging, core)
  const target = path.join(directory, core)
  const backup = path.join(staging, 'previous')
  let preserveBackup = false
  try {
    await writeFile(staged, binary, { mode: 0o755 })
    await chmod(staged, 0o755)
    await validate(staged)
    const hadUpdate = existsSync(target)
    if (hadUpdate) await copyFile(target, backup)
    if (authorize) await authorize(staged)
    await rename(staged, target)
    try {
      await restart()
      await verify()
    } catch (error) {
      try {
        if (hadUpdate) await rename(backup, target)
        else await rm(target, { force: true })
        await restart()
      } catch (rollbackError) {
        preserveBackup = true
        throw new CoreUpdateInstallError(false, new AggregateError([error, rollbackError]))
      }
      throw new CoreUpdateInstallError(true, error)
    }
  } finally {
    if (!preserveBackup) await rm(staging, { recursive: true, force: true })
  }
}
