import { posix } from 'node:path'
import { AUTH_CALLBACK, AuthRequestError } from './contracts'

interface ProtocolDependencies {
  platform: NodeJS.Platform
  isPackaged: boolean
  executablePath: string
  getApplicationInfoForProtocol(url: string): Promise<{ path: string }>
  resolvePath(path: string): Promise<string>
}

/** Electron's macOS default-handler check compares bundle IDs, not application copies. */
export async function assertCurrentProtocolHandler(deps: ProtocolDependencies): Promise<void> {
  if (deps.platform !== 'darwin' || !deps.isPackaged) return

  let current: string
  let registered: string
  try {
    const executableDirectory = posix.dirname(deps.executablePath)
    const contentsDirectory = posix.dirname(executableDirectory)
    const bundlePath = posix.dirname(contentsDirectory)
    if (
      !posix.isAbsolute(deps.executablePath) ||
      posix.basename(executableDirectory) !== 'MacOS' ||
      posix.basename(contentsDirectory) !== 'Contents' ||
      !bundlePath.toLowerCase().endsWith('.app')
    ) {
      throw new Error('Invalid application location')
    }
    const handler = await deps.getApplicationInfoForProtocol(AUTH_CALLBACK)
    if (typeof handler.path !== 'string' || !posix.isAbsolute(handler.path)) {
      throw new Error('Invalid protocol handler location')
    }
    ;[current, registered] = await Promise.all([
      deps.resolvePath(bundlePath),
      deps.resolvePath(handler.path)
    ])
  } catch {
    throw new AuthRequestError('protocol-unavailable')
  }
  if (current !== registered) throw new AuthRequestError('protocol-conflict')
}
