/** Display-only service data. OIDC credentials and subscription URLs stay in the main process. */
interface KoalaService {
  id: number
  name: string
  nextDueDate?: string
  imported: boolean
  active: boolean
}

type KoalaServiceError =
  | 'not-signed-in'
  | 'session-changed'
  | 'network-error'
  | 'plugin-unavailable'
  | 'configuration-error'
  | 'access-denied'
  | 'service-unavailable'
  | 'invalid-response'
  | 'import-failed'
  | 'activation-failed'

type KoalaServiceListResult =
  | { ok: true; services: KoalaService[] }
  | { ok: false; error: KoalaServiceError }

type KoalaServiceImportResult =
  | { ok: true; profileId: string; alreadyImported: boolean }
  | { ok: false; error: KoalaServiceError }
