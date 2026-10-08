import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createAuthSession } from './session'
import { AuthRequestError } from './contracts'
import { createSecureAuthStore } from './secure-store'
import { createClientSecretLoader } from './client-secret'
import { createWhmcsOidc } from './oidc'
import { assertCurrentProtocolHandler } from './protocol'
import { createWhmcsServices } from './services'
import { createServiceDiagnostics } from './services-diagnostics'
import { getProfileConfig, importServiceProfile } from '../config/profile'
import { logDir } from '../utils/dirs'

// Capture optional application-credential overrides and keep them out of child processes.
const environmentSecret = process.env.KOALA_WHMCS_CLIENT_SECRET
const sourceFile = process.env.KOALA_WHMCS_CLIENT_SECRET_FILE
delete process.env.KOALA_WHMCS_CLIENT_SECRET
delete process.env.KOALA_WHMCS_CLIENT_SECRET_FILE
const bundledSecret =
  typeof __KOALA_WHMCS_CLIENT_SECRET__ === 'string' ? __KOALA_WHMCS_CLIENT_SECRET__ : undefined

let auth: ReturnType<typeof createAuthSession> | undefined

async function openLoginBrowser(url: string): Promise<void> {
  // macOS/Linux need the protocol declarations in the installed app bundle.
  if (!app.isPackaged && process.platform !== 'win32') {
    throw new AuthRequestError('protocol-unavailable')
  }
  const registered =
    process.defaultApp && process.argv[1]
      ? app.setAsDefaultProtocolClient('koala-clash', process.execPath, [resolve(process.argv[1])])
      : app.isDefaultProtocolClient('koala-clash') || app.setAsDefaultProtocolClient('koala-clash')
  if (!registered) throw new AuthRequestError('protocol-unavailable')
  await assertCurrentProtocolHandler({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: process.execPath,
    getApplicationInfoForProtocol: (callback) => app.getApplicationInfoForProtocol(callback),
    resolvePath: realpath
  })
  await shell.openExternal(url)
}

function session(): ReturnType<typeof createAuthSession> {
  const crypto = {
    isAvailable: () =>
      safeStorage.isEncryptionAvailable() &&
      !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'),
    encrypt: (value: string) => safeStorage.encryptString(value),
    decrypt: (value: Buffer) => safeStorage.decryptString(value)
  }
  auth ??= createAuthSession({
    // Account credentials are deliberately outside portable/profile backup data.
    // A separate v2 file prevents old bridge grants from being sent to WHMCS.
    store: createSecureAuthStore(
      join(app.getPath('userData'), 'auth', 'whmcs-session.enc'),
      crypto
    ),
    provider: createWhmcsOidc({
      getClientSecret: createClientSecretLoader({
        filePath: join(app.getPath('userData'), 'auth', 'client-secret.enc'),
        environmentSecret,
        sourceFile,
        bundledSecret,
        crypto
      })
    }),
    openBrowser: openLoginBrowser,
    onChange: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('authStateChanged', state)
      }
    }
  })
  return auth
}

export const authGetState = async (): Promise<KoalaAuthState> => {
  const state = await session().getState()
  if (state.status === 'signed-in') void services.bind()
  return state
}
export const authLogin = (): Promise<KoalaAuthState> => session().login()
export const authReopenLogin = (): Promise<KoalaAuthState> => session().reopenLogin()
export const authLogout = (): Promise<KoalaAuthState> => session().logout()
export const authCancelLogin = (): Promise<KoalaAuthState> => session().cancelLogin()
export const handleAuthCallback = async (url: string): Promise<boolean> => {
  const handled = await session().acceptCallback(url)
  if (handled) void services.bind()
  return handled
}

const serviceDiagnostics = createServiceDiagnostics({
  filePath: () => join(logDir(), 'whmcs-services.log'),
  appVersion: () => app.getVersion()
})

const services = createWhmcsServices({
  onDiagnostic: serviceDiagnostics.write,
  getSession: () => session().serviceSession(),
  getProfiles: async () => (await getProfileConfig()).items ?? [],
  getCurrentProfileId: async () => (await getProfileConfig()).current,
  importProfile: importServiceProfile
})

export const authListServices = (): Promise<KoalaServiceListResult> => services.list()
export const authImportService = (id: number): Promise<KoalaServiceImportResult> =>
  services.importService(id)
