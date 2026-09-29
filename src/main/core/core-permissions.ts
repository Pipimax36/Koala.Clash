import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const installDir = '/Library/Application Support/Koala Clash/Cores'
const fingerprints = new Map<string, { version: string; hash: string }>()

function fingerprint(file: string): string {
  const stat = statSync(file)
  const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  const cached = fingerprints.get(file)
  if (cached?.version === version) return cached.hash
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
  fingerprints.set(file, { version, hash })
  return hash
}

export function isPrivilegedExecutable(stat: {
  uid: number
  mode: number
  isFile: () => boolean
}): boolean {
  return (
    stat.isFile() && stat.uid === 0 && (stat.mode & 0o4100) === 0o4100 && (stat.mode & 0o022) === 0
  )
}

export function hasCorePermission(file: string): boolean {
  try {
    // lstat deliberately rejects symbolic links.
    return isPrivilegedExecutable(lstatSync(file))
  } catch {
    return false
  }
}

export function getMacCoreInstallPath(source: string): string {
  return path.join(installDir, `${path.basename(source)}-${fingerprint(source)}`)
}

export function resolveMacCorePath(source: string): string {
  const installed = getMacCoreInstallPath(source)
  if (hasCorePermission(installed) && fingerprint(installed) === fingerprint(source)) {
    return installed
  }
  return source
}

export function getMacCoreAuthorizationPaths(source: string): string[] {
  const prefix = `${path.basename(source)}-`
  let installed: string[] = []
  try {
    installed = readdirSync(installDir)
      .filter((name) => name.startsWith(prefix) && /^[a-f0-9]{64}$/.test(name.slice(prefix.length)))
      .map((name) => path.join(installDir, name))
  } catch {
    // No installed authorization copies yet.
  }
  return [source, ...installed].filter(hasCorePermission)
}

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function toAppleScript(script: string): string {
  // Escape the shell command separately from its arguments.
  return `do shell script ${JSON.stringify(script)} with administrator privileges`
}

export async function runMacAdminScript(script: string): Promise<void> {
  await execFileAsync('/usr/bin/osascript', ['-e', toAppleScript(script)])
}

interface GrantDependencies {
  runAdmin?: (script: string, staged: string) => Promise<void>
  verify?: (installed: string) => boolean
  preserveSource?: string
}

export async function grantMacCorePermission(
  source: string,
  {
    runAdmin = runMacAdminScript,
    verify = hasCorePermission,
    preserveSource
  }: GrantDependencies = {}
): Promise<void> {
  const name = path.basename(source)
  if (name !== 'mihomo' && name !== 'mihomo-alpha') throw new Error('Unknown bundled core')
  const target = getMacCoreInstallPath(source)
  // Retain one authorized fallback while a new version is being activated.
  const previous = preserveSource ? getMacCoreInstallPath(preserveSource) : undefined
  const hash = fingerprint(source)
  // Read protected source folders as the app, before the privileged helper starts.
  const stageDir = await mkdtemp(path.join(tmpdir(), 'koala-core-'))
  const staged = path.join(stageDir, 'core')
  try {
    await copyFile(source, staged)
    await chmod(staged, 0o700)
    if (fingerprint(staged) !== hash) throw new Error('Core changed while preparing authorization')
    const dirs = ['/Library', '/Library/Application Support', path.dirname(installDir), installDir]
    // Every existing ancestor must be a real, root-owned, non-writable directory.
    // New directories are created only beneath an already-validated parent.
    const script = [
      'set -eu',
      ...dirs.map((dir) => {
        const quoted = quoteShellArg(dir)
        return `if [ ! -e ${quoted} ] && [ ! -L ${quoted} ]; then /usr/bin/install -d -o root -g wheel -m 0755 ${quoted}; fi; [ -d ${quoted} ] && [ ! -L ${quoted} ] && [ "$(/usr/bin/stat -f %u ${quoted})" = 0 ] && [ -z "$(/usr/bin/find ${quoted} -prune \\( -perm -002 -o -perm -020 \\) -print)" ]`
      }),
      `target=${quoteShellArg(target)}`,
      `temporary=$(/usr/bin/mktemp ${quoteShellArg(path.join(installDir, '.install.XXXXXX'))})`,
      `trap '/bin/rm -f "$temporary"' EXIT`,
      `/usr/bin/install -o root -g wheel -m 0755 ${quoteShellArg(staged)} "$temporary"`,
      `actual=$(/usr/bin/shasum -a 256 "$temporary"); [ "\${actual%% *}" = ${quoteShellArg(hash)} ]`,
      '/bin/chmod 4755 "$temporary"',
      '/bin/mv -f "$temporary" "$target"',
      // All other old versions lose elevated permissions.
      `/usr/bin/find ${quoteShellArg(installDir)} -type f -name ${quoteShellArg(`${name}-*`)} ! -name ${quoteShellArg(path.basename(target))}${previous ? ` ! -name ${quoteShellArg(path.basename(previous))}` : ''} -exec /bin/chmod a-s {} +`
    ].join('\n')
    await runAdmin(script, staged)
    if (!verify(target)) throw new Error('Core authorization verification failed')
  } finally {
    fingerprints.delete(staged)
    await rm(stageDir, { recursive: true, force: true })
  }
}
