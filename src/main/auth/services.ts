import { createHash, randomBytes } from 'node:crypto'
import { AUTH_ISSUER, AUTH_ORIGIN, isIdentityToken } from './contracts'
import { sanitizeServiceDiagnostic, type ServiceDiagnostic } from './services-diagnostics'

export class ServiceRequestError extends Error {
  constructor(public readonly reason: KoalaServiceError) {
    super(reason)
  }
}

/** Main-process capability; never returned through IPC. */
export interface ServiceSession {
  identity: string
  accessToken: string
  idToken?: string
  assertCurrent(): void
}

export interface ServiceImport {
  id: number
  name: string
  subscriptionUrl: string
  profileId: string
  identity: string
  assertCurrent(): void
}

interface Dependencies {
  getSession(): Promise<ServiceSession>
  getProfiles(): Promise<ProfileItem[]>
  getCurrentProfileId?(): Promise<string | undefined>
  importProfile(service: ServiceImport): Promise<{ profileId: string; alreadyImported: boolean }>
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  onDiagnostic?(event: ServiceDiagnostic): void
}

interface RemoteService {
  id: number
  name: string
  nextDueDate?: string
}

const ENDPOINT = `${AUTH_ORIGIN}/modules/addons/koala_services/api.php`
const MAX_BODY = 256 * 1024
const errors = new Set<KoalaServiceError>([
  'not-signed-in',
  'network-error',
  'configuration-error',
  'access-denied',
  'service-unavailable',
  'plugin-unavailable'
])

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ServiceRequestError('invalid-response')
  return value as Record<string, unknown>
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function service(value: unknown): RemoteService {
  const data = record(value)
  if (
    !positiveId(data.id) ||
    typeof data.name !== 'string' ||
    !data.name.trim() ||
    data.name.length > 256 ||
    [...data.name].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new ServiceRequestError('invalid-response')
  if (
    data.nextDueDate !== undefined &&
    (typeof data.nextDueDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(data.nextDueDate) ||
      !Number.isFinite(Date.parse(`${data.nextDueDate}T00:00:00Z`)) ||
      new Date(`${data.nextDueDate}T00:00:00Z`).toISOString().slice(0, 10) !== data.nextDueDate)
  )
    throw new ServiceRequestError('invalid-response')
  return {
    id: data.id,
    name: data.name,
    ...(data.nextDueDate && { nextDueDate: data.nextDueDate as string })
  }
}

function subscriptionUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  )
    throw new ServiceRequestError('invalid-response')
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('Invalid URL')
    return url.toString()
  } catch {
    throw new ServiceRequestError('invalid-response')
  }
}

export function serviceProfileId(identity: string, serviceId: number): string {
  return `whmcs-${createHash('sha256').update(`${AUTH_ISSUER}\0${identity}\0${serviceId}`).digest('hex')}`
}

/** One authenticated API surface; renderer receives display fields and controlled errors only. */
export function createWhmcsServices(deps: Dependencies) {
  const fetch = deps.fetch ?? globalThis.fetch
  let importQueue: Promise<unknown> = Promise.resolve()
  let bindingAttempt: { lease: ServiceSession; result: Promise<boolean> } | undefined

  function begin(action: ServiceDiagnostic['action']) {
    const started = performance.now()
    const details: Record<string, unknown> = {
      action,
      operationId: randomBytes(8).toString('hex'),
      stage: 'session'
    }
    function emit(event: ServiceDiagnostic['event'], fields: Record<string, unknown> = {}): void {
      try {
        const safe = sanitizeServiceDiagnostic({
          ...details,
          ...fields,
          event,
          durationMs: Math.max(0, Math.round(performance.now() - started))
        })
        if (safe) deps.onDiagnostic?.(safe)
      } catch {
        // Diagnostics must never change login, service access or profile import behavior.
      }
    }
    emit('start')
    return {
      emit,
      stage(value: ServiceDiagnostic['stage']): void {
        details.stage = value
      },
      response(response: Response): void {
        const mime = (response.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim()
        details.httpStatus = response.status
        details.contentType = !mime
          ? 'missing'
          : mime === 'application/json'
            ? 'json'
            : mime === 'text/html'
              ? 'html'
              : 'other'
        details.pluginVersion = response.headers.get('x-koala-services-version')
        details.requestId = response.headers.get('x-koala-request-id')
        emit('response')
      },
      payload(data: Record<string, unknown>): void {
        details.diagnostic = data.diagnostic
        details.requestId ??= data.requestId
        details.query = data.diagnostics
      },
      timedOut(value: boolean): void {
        details.timedOut = value
      }
    }
  }
  type Trace = ReturnType<typeof begin>

  async function request(
    lease: ServiceSession,
    body: Record<string, unknown>,
    trace: Trace
  ): Promise<Record<string, unknown>> {
    lease.assertCurrent()
    if (!isIdentityToken(lease.idToken)) throw new ServiceRequestError('not-signed-in')
    const abort = new AbortController()
    // Resolve verifies the OIDC token and then calls the subscription provider.
    const timeout = setTimeout(
      () => abort.abort(),
      deps.timeoutMs ?? (body.action === 'resolve' ? 40_000 : 30_000)
    )
    timeout.unref?.()
    try {
      trace.stage('request')
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: abort.signal,
        headers: {
          Authorization: `Bearer ${lease.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ ...body, identityToken: lease.idToken })
      })
      lease.assertCurrent()
      trace.response(response)
      trace.stage('decode')
      const authenticationError =
        response.status === 401
          ? 'not-signed-in'
          : response.status === 403
            ? 'access-denied'
            : undefined
      const json =
        (response.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim() ===
        'application/json'
      if (!json)
        throw new ServiceRequestError(
          authenticationError ??
            (response.status === 404
              ? 'plugin-unavailable'
              : response.status >= 500
                ? 'network-error'
                : 'invalid-response')
        )
      let data: Record<string, unknown>
      try {
        const declared = response.headers.get('content-length')
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY))
          throw new ServiceRequestError('invalid-response')
        if (!response.body) throw new ServiceRequestError('invalid-response')
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          for (;;) {
            const chunk = await reader.read()
            lease.assertCurrent()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > MAX_BODY) throw new ServiceRequestError('invalid-response')
            chunks.push(chunk.value)
          }
        } finally {
          void reader.cancel().catch(() => undefined)
        }
        try {
          data = record(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
          )
        } catch {
          throw new ServiceRequestError('invalid-response')
        }
      } catch (error) {
        // Keep HTTP authentication errors stable even if a proxy sends a malformed body.
        lease.assertCurrent()
        if (authenticationError) throw new ServiceRequestError(authenticationError)
        throw error
      }
      trace.payload(data)
      if (authenticationError) throw new ServiceRequestError(authenticationError)
      if (!response.ok) {
        if (response.status === 404) throw new ServiceRequestError('service-unavailable')
        if (errors.has(data.error as KoalaServiceError))
          throw new ServiceRequestError(data.error as KoalaServiceError)
        throw new ServiceRequestError(response.status >= 500 ? 'network-error' : 'invalid-response')
      }
      if (data.version !== 1) throw new ServiceRequestError('invalid-response')
      return data
    } catch (error) {
      trace.timedOut(abort.signal.aborted)
      lease.assertCurrent()
      if (error instanceof ServiceRequestError) throw error
      throw new ServiceRequestError('network-error')
    } finally {
      clearTimeout(timeout)
      abort.abort()
    }
  }

  function failure(error: unknown, trace: Trace): { ok: false; error: KoalaServiceError } {
    const reason: KoalaServiceError =
      error instanceof ServiceRequestError ? error.reason : 'import-failed'
    trace.emit('failed', { error: reason })
    return { ok: false, error: reason }
  }

  return {
    /** Register client-bound proof while the short-lived ID token is fresh. Never gates login. */
    async bind(): Promise<boolean> {
      let trace: Trace | undefined
      try {
        const lease = await deps.getSession()
        if (
          bindingAttempt?.lease.identity === lease.identity &&
          bindingAttempt.lease.accessToken === lease.accessToken
        ) {
          try {
            bindingAttempt.lease.assertCurrent()
            return bindingAttempt.result
          } catch {
            // Even a same-account login creates a new capability generation.
          }
        }
        trace = begin('bind')
        const currentTrace = trace
        const result = (async () => {
          try {
            const data = await request(lease, { action: 'bind' }, currentTrace)
            lease.assertCurrent()
            currentTrace.stage('validate')
            if (data.bound !== true) throw new ServiceRequestError('invalid-response')
            currentTrace.emit('complete')
            return true
          } catch (error) {
            failure(error, currentTrace)
            return false
          }
        })()
        bindingAttempt = { lease, result }
        const bound = await result
        if (!bound && bindingAttempt?.result === result) bindingAttempt = undefined
        return bound
      } catch (error) {
        failure(error, trace ?? begin('bind'))
        return false
      }
    },

    async list(): Promise<KoalaServiceListResult> {
      const trace = begin('list')
      try {
        const lease = await deps.getSession()
        const data = await request(lease, { action: 'list' }, trace)
        trace.stage('validate')
        if (!Array.isArray(data.services) || data.services.length > 1000)
          throw new ServiceRequestError('invalid-response')
        const services = data.services.map(service)
        if (new Set(services.map(({ id }) => id)).size !== services.length)
          throw new ServiceRequestError('invalid-response')
        trace.stage('profiles')
        const profiles = await deps.getProfiles()
        const currentProfileId = await deps.getCurrentProfileId?.()
        lease.assertCurrent()
        const result = {
          ok: true as const,
          services: services.map((item) => ({
            ...item,
            imported: profiles.some((profile) =>
              profile.whmcsServices?.some(
                (binding) => binding.identity === lease.identity && binding.serviceId === item.id
              )
            ),
            active: profiles.some(
              (profile) =>
                profile.id === currentProfileId &&
                profile.whmcsServices?.some(
                  (binding) => binding.identity === lease.identity && binding.serviceId === item.id
                )
            )
          }))
        }
        trace.emit('complete', {
          serviceCount: result.services.length,
          importedCount: result.services.filter((item) => item.imported).length
        })
        return result
      } catch (error) {
        return failure(error, trace)
      }
    },

    async importService(id: number): Promise<KoalaServiceImportResult> {
      const trace = begin('resolve')
      try {
        if (!positiveId(id)) throw new ServiceRequestError('service-unavailable')
        const lease = await deps.getSession()
        const task = importQueue.then(async (): Promise<KoalaServiceImportResult> => {
          lease.assertCurrent()
          const data = await request(lease, { action: 'resolve', serviceId: id }, trace)
          trace.stage('validate')
          const item = service(data.service)
          if (item.id !== id) throw new ServiceRequestError('invalid-response')
          const url = subscriptionUrl(data.subscriptionUrl)
          lease.assertCurrent()
          trace.stage('import')
          const imported = await deps.importProfile({
            id,
            name: item.name,
            subscriptionUrl: url,
            identity: lease.identity,
            profileId: serviceProfileId(lease.identity, id),
            assertCurrent: lease.assertCurrent
          })
          lease.assertCurrent()
          trace.emit('complete', { alreadyImported: imported.alreadyImported })
          return { ok: true, ...imported }
        })
        importQueue = task.catch(() => undefined)
        return await task
      } catch (error) {
        return failure(error, trace)
      }
    }
  }
}
