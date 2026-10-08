import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface ServiceQueryDiagnostic {
  version: 1
  reason:
    | 'no-owned-services'
    | 'no-active-services'
    | 'product-not-enabled'
    | 'account-or-product-filtered'
    | 'unavailable'
  clientCount?: number
  ownedServices?: number
  activeServices?: number
  allowedServices?: number
  allowedProductIds?: number[]
}

export interface ServiceDiagnostic {
  action: 'bind' | 'list' | 'resolve'
  event: 'start' | 'response' | 'complete' | 'failed'
  operationId: string
  stage?: 'session' | 'request' | 'decode' | 'validate' | 'profiles' | 'import'
  durationMs?: number
  httpStatus?: number
  contentType?: 'json' | 'html' | 'other' | 'missing'
  pluginVersion?: string
  requestId?: string
  error?: KoalaServiceError
  serviceCount?: number
  importedCount?: number
  alreadyImported?: boolean
  timedOut?: boolean
  diagnostic?: string
  query?: ServiceQueryDiagnostic
}

const diagnosticCodes = new Set([
  'client-uuid-not-found',
  'client-uuid-matches-user',
  'client-uuid-ambiguous',
  'client-uuid-mismatch',
  'client-closed',
  'client-status-unknown',
  'user-uuid-not-found',
  'user-uuid-ambiguous',
  'user-uuid-mismatch',
  'owned-client-limit',
  'no-owned-accessible-client',
  'invalid-client-mapping',
  'service-owner-mismatch',
  'service-not-active',
  'client-inactive',
  'no-owned-active-client',
  'whmcs-service-unavailable',
  'whmcs-service-changed',
  'whmcs-remnawave-mapping-missing',
  'whmcs-remnawave-mapping-invalid',
  'remnawave-user-not-found',
  'remnawave-id-mismatch',
  'remnawave-user-inactive',
  'remnawave-user-expired',
  'remnawave-expiry-invalid',
  'remnawave-response-invalid',
  'remnawave-access-denied',
  'remnawave-subscription-missing',
  'remnawave-request-failed',
  'remnawave-subscription-invalid',
  'remnawave-configuration-error'
])

const serviceErrors: readonly KoalaServiceError[] = [
  'not-signed-in',
  'session-changed',
  'network-error',
  'plugin-unavailable',
  'configuration-error',
  'access-denied',
  'service-unavailable',
  'invalid-response',
  'import-failed',
  'activation-failed'
]

function record(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Read own data properties only: accessors, prototypes and toJSON hooks are not diagnostic data.
function field(value: object, name: string): unknown {
  return Object.getOwnPropertyDescriptor(value, name)?.value
}

function member<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.includes(value as T)
}

function integer(value: unknown, maximum: number, minimum = 0): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  )
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{16}$/i.test(value)
}

function version(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)
  )
}

function queryDiagnostic(value: unknown): ServiceQueryDiagnostic | undefined {
  if (!record(value) || field(value, 'version') !== 1) return undefined
  const reason = field(value, 'reason')
  if (
    !member(reason, [
      'no-owned-services',
      'no-active-services',
      'product-not-enabled',
      'account-or-product-filtered',
      'unavailable'
    ] as const)
  )
    return undefined
  const output: ServiceQueryDiagnostic = { version: 1, reason }
  for (const name of [
    'clientCount',
    'ownedServices',
    'activeServices',
    'allowedServices'
  ] as const) {
    const count = field(value, name)
    if (integer(count, 1_000_000)) output[name] = count
  }
  const products = field(value, 'allowedProductIds')
  if (Array.isArray(products)) {
    const length = field(products, 'length')
    if (integer(length, 100)) {
      const ids: number[] = []
      for (let index = 0; index < length; index++) {
        const id = field(products, String(index))
        if (!integer(id, Number.MAX_SAFE_INTEGER, 1)) return output
        ids.push(id)
      }
      output.allowedProductIds = ids
    }
  }
  return output
}

/** Build a fresh allowlisted object; provider payloads and arbitrary metadata never reach disk. */
export function sanitizeServiceDiagnostic(value: unknown): ServiceDiagnostic | undefined {
  try {
    if (!record(value)) return undefined
    const action = field(value, 'action')
    const event = field(value, 'event')
    const operationId = field(value, 'operationId')
    if (
      !member(action, ['bind', 'list', 'resolve'] as const) ||
      !member(event, ['start', 'response', 'complete', 'failed'] as const) ||
      !identifier(operationId)
    )
      return undefined
    const output: ServiceDiagnostic = { action, event, operationId: operationId.toLowerCase() }
    const stage = field(value, 'stage')
    if (member(stage, ['session', 'request', 'decode', 'validate', 'profiles', 'import'] as const))
      output.stage = stage
    const duration = field(value, 'durationMs')
    if (integer(duration, 86_400_000)) output.durationMs = duration
    const status = field(value, 'httpStatus')
    if (integer(status, 599, 100)) output.httpStatus = status
    const contentType = field(value, 'contentType')
    if (member(contentType, ['json', 'html', 'other', 'missing'] as const))
      output.contentType = contentType
    const pluginVersion = field(value, 'pluginVersion')
    if (version(pluginVersion)) output.pluginVersion = pluginVersion
    const requestId = field(value, 'requestId')
    if (identifier(requestId)) output.requestId = requestId.toLowerCase()
    const error = field(value, 'error')
    if (member(error, serviceErrors)) output.error = error
    for (const name of ['serviceCount', 'importedCount'] as const) {
      const count = field(value, name)
      if (integer(count, 1_000_000)) output[name] = count
    }
    for (const name of ['alreadyImported', 'timedOut'] as const) {
      const flag = field(value, name)
      if (typeof flag === 'boolean') output[name] = flag
    }
    const diagnostic = field(value, 'diagnostic')
    if (typeof diagnostic === 'string' && diagnosticCodes.has(diagnostic))
      output.diagnostic = diagnostic
    const query = queryDiagnostic(field(value, 'query'))
    if (query) output.query = query
    return output
  } catch {
    return undefined
  }
}

export function createServiceDiagnostics(options: {
  filePath: () => string
  appVersion: () => string
  maxBytes?: number
}): { write(event: ServiceDiagnostic): void; flush(): Promise<void> } {
  let queue: Promise<void> = Promise.resolve()
  let pending = 0
  const maxBytes = integer(options.maxBytes, 1024 * 1024, 1) ? options.maxBytes : 1024 * 1024

  async function append(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line)
    if (bytes > maxBytes) return
    const path = options.filePath()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const flags =
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0)
    const file = await open(path, flags, 0o600)
    let rotate = false
    try {
      const info = await file.stat()
      if (!info.isFile()) return
      await file.chmod(0o600)
      rotate = info.size + bytes > maxBytes
      if (!rotate) await file.writeFile(line, 'utf8')
    } finally {
      await file.close()
    }
    if (rotate) {
      await rm(`${path}.1`, { force: true })
      await rename(path, `${path}.1`)
      const fresh = await open(path, flags, 0o600)
      try {
        if (!(await fresh.stat()).isFile()) return
        await fresh.chmod(0o600)
        await fresh.writeFile(line, 'utf8')
      } finally {
        await fresh.close()
      }
    }
  }

  return {
    write(event): void {
      try {
        if (pending >= 1000) return
        const safe = sanitizeServiceDiagnostic(event)
        if (!safe) return
        const appVersion = options.appVersion()
        const line =
          JSON.stringify({
            time: new Date().toISOString(),
            component: 'whmcs-services',
            appVersion: version(appVersion) ? appVersion : 'unknown',
            ...safe
          }) + '\n'
        if (Buffer.byteLength(line) > 4096) return
        pending++
        queue = queue.then(async () => {
          try {
            await append(line)
          } catch {
            /* Diagnostics must not affect the operation being diagnosed. */
          } finally {
            pending--
          }
        })
      } catch {
        // Malformed diagnostic inputs and unavailable application metadata are ignored.
      }
    },
    flush: () => queue
  }
}
