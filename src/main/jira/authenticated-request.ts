import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import { withSpan } from '../observability/tracer'
import type { JiraAuthType, JiraSite } from '../../shared/jira/jira-types'
import { isJiraGatewayBaseUrl } from './gateway-base-url'
import {
  readFetchResponseBytesWithinLimit,
  readFetchResponseJsonWithinLimit
} from '../../shared/fetch-response-body'

// Electron's Chrome UA triggers Atlassian XSRF rejection on token-authenticated writes; no-check does not bypass it.
const JIRA_API_USER_AGENT = 'Orca'

export type JiraClientForSite = {
  site: JiraSite
  authorization: string
}

// Server/DC needs REST v2; Cloud uses v3.
export function apiBasePath(site: JiraSite): string {
  return site.authType === 'server' ? '/rest/api/2' : '/rest/api/3'
}

export class JiraApiError extends Error {
  status: number | null
  /** Jira's per-field rejections, keyed by field key. Present when Jira answered
   *  with an `errors` object, which is how a transition or edit names the field
   *  it refused. */
  fieldErrors?: Record<string, string>
  /** Jira's non-field error strings, e.g. a workflow rule that failed outright. */
  errorMessages?: string[]
  /** True when the token's scopes do not cover this request, so the credential
   *  is valid but under-scoped and must not be cleared. */
  scopeMismatch = false

  constructor(
    message: string,
    status: number | null = null,
    detail?:
      | {
          fieldErrors?: Record<string, string>
          errorMessages?: string[]
          scopeMismatch?: boolean
        }
      // Upstream's call sites pass the scope flag positionally rather than as detail.
      | boolean
  ) {
    super(message)
    this.status = status
    const fields = typeof detail === 'boolean' ? undefined : detail
    this.fieldErrors = fields?.fieldErrors
    this.errorMessages = fields?.errorMessages
    this.scopeMismatch = typeof detail === 'boolean' ? detail : fields?.scopeMismatch === true
  }
}

/** REST base URL: the scoped-token gateway for Cloud sites that declare one. */
export function apiBaseUrl(site: JiraSite): string {
  if (site.authType !== 'server' && site.apiBaseUrl !== undefined) {
    if (!isJiraGatewayBaseUrl(site.apiBaseUrl)) {
      throw new JiraApiError('Invalid Jira gateway URL. Reconnect this Jira site.')
    }
    return site.apiBaseUrl
  }
  return site.siteUrl
}

export function authHeader(email: string, apiToken: string, _authType?: JiraAuthType): string {
  // Server/DC uses Bearer for username-free PATs, Basic for username/password pairs.
  if (!email) {
    return `Bearer ${apiToken}`
  }
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
}

function describeErrorCause(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('cause' in error)) {
    return undefined
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`
  }
  return cause === undefined ? undefined : String(cause)
}

export async function jiraFetch(url: string, init: RequestInit): Promise<Response> {
  return withSpan(
    'jira.request',
    async (span) => {
      span.setAttribute('jira.siteUrl', new URL(url).origin)
      const httpClient = getMainHttpClient()
      const proxySession = httpClient.proxySession()
      await ensureElectronProxyFromEnvironment({
        ...(proxySession ? { proxySession } : {}),
        probeUrl: url
      }).catch((error) => {
        span.addEvent('jira.proxySetupFailed', {
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      })
      try {
        // Desktop Chromium follows proxy/session state and VPN changes; headless hosts supply Node fetch.
        return await httpClient.fetch(url, init)
      } catch (error) {
        span.setAttribute(
          'jira.transportErrorName',
          error instanceof Error ? error.name : typeof error
        )
        span.setAttribute(
          'jira.transportErrorMessage',
          error instanceof Error ? error.message : String(error)
        )
        const cause = describeErrorCause(error)
        if (cause) {
          span.setAttribute('jira.transportErrorCause', cause)
        }
        throw error
      }
    },
    { kind: 'client' }
  )
}

export async function requestWithCredentials(
  siteUrl: string,
  email: string,
  apiToken: string,
  path: string,
  init?: RequestInit,
  authType?: JiraAuthType
): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', JIRA_API_USER_AGENT)
  headers.set('Authorization', authHeader(email, apiToken, authType))
  const response = await jiraFetch(`${siteUrl}${path}`, {
    ...init,
    headers,
    ...(isJiraGatewayBaseUrl(siteUrl) ? { redirect: 'error' as const } : {})
  })
  if (!response.ok) {
    throw await toJiraError(response, `${siteUrl}${path}`)
  }
  if (response.status === 204) {
    return null
  }
  return response.json()
}

type JiraErrorDetail = {
  message: string
  fieldErrors?: Record<string, string>
  errorMessages?: string[]
  scopeMismatch?: boolean
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isScopeMismatch(response: Response, message: string, url: string): boolean {
  const target = new URL(url)
  return (
    target.origin === 'https://api.atlassian.com' &&
    (response.status === 401 || response.status === 403) &&
    /scope does not match|insufficient_scope|scope mismatch/i.test(
      `${message} ${response.headers.get('www-authenticate') ?? ''}`
    )
  )
}

function scopeMismatchMessage(response: Response, url: string): string {
  const target = new URL(url)
  const scope = /\/(myself|user|users)(\/|$)/.test(target.pathname)
    ? 'read:jira-user'
    : 'read:jira-work for reads or write:jira-work for edits'
  return `Jira rejected this request's API token scopes at ${target.host}${target.pathname} (HTTP ${response.status}). Add ${scope}; board ordering also needs the Jira Software board scopes listed in the connection guide.`
}

async function readJiraErrorDetail(
  response: Response,
  url: string,
  maxResponseBytes?: number
): Promise<JiraErrorDetail> {
  let message = response.statusText || `Jira request failed (${response.status})`
  let fieldErrors: Record<string, string> | undefined
  let errorMessages: string[] | undefined
  try {
    const raw: unknown =
      maxResponseBytes === undefined
        ? await response.json()
        : await readFetchResponseJsonWithinLimit(response, maxResponseBytes)
    const data = isUnknownRecord(raw) ? raw : {}
    const errors = isUnknownRecord(data.errors) ? data.errors : {}
    fieldErrors = Object.fromEntries(
      Object.entries(errors).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
    errorMessages = Array.isArray(data.errorMessages)
      ? data.errorMessages.filter((item): item is string => typeof item === 'string')
      : undefined
    const messages = [
      ...(errorMessages ?? []),
      ...Object.values(fieldErrors),
      ...(typeof data.message === 'string' ? [data.message] : [])
    ].filter(Boolean)
    if (messages.length > 0) {
      message = messages.join('; ')
    }
  } catch {
    // Fall through to status text for non-JSON responses.
  }
  const scopeMismatch = isScopeMismatch(response, message, url)
  return {
    message: scopeMismatch ? scopeMismatchMessage(response, url) : message,
    ...(fieldErrors && Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
    ...(errorMessages && errorMessages.length > 0 ? { errorMessages } : {}),
    ...(scopeMismatch ? { scopeMismatch } : {})
  }
}

async function toJiraError(
  response: Response,
  url: string,
  maxResponseBytes?: number
): Promise<JiraApiError> {
  const detail = await readJiraErrorDetail(response, url, maxResponseBytes)
  return new JiraApiError(detail.message, response.status, detail)
}

export async function jiraRequest<T>(
  client: JiraClientForSite,
  path: string,
  init?: RequestInit,
  maxResponseBytes?: number
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('User-Agent', JIRA_API_USER_AGENT)
  headers.set('Authorization', client.authorization)
  const url = `${apiBaseUrl(client.site)}${path}`
  const response = await jiraFetch(url, {
    ...init,
    headers,
    ...(isJiraGatewayBaseUrl(apiBaseUrl(client.site)) ? { redirect: 'error' as const } : {})
  })
  if (!response.ok) {
    throw await toJiraError(response, url, maxResponseBytes)
  }
  if (response.status === 204) {
    return null as T
  }
  if (maxResponseBytes !== undefined) {
    return readFetchResponseJsonWithinLimit<T>(response, maxResponseBytes)
  }
  return (await response.json()) as T
}

function resolveBinaryRequestUrl(site: JiraSite, pathOrUrl: string): URL {
  const siteUrl = new URL(site.siteUrl)
  const baseUrl = apiBaseUrl(site)
  const requestUrl = /^https?:\/\//i.test(pathOrUrl)
    ? new URL(pathOrUrl)
    : new URL(`${site.siteUrl}${pathOrUrl}`)
  if (!requestUrl.username && !requestUrl.password) {
    if (baseUrl !== site.siteUrl && requestUrl.href.startsWith(`${baseUrl}/`)) {
      return requestUrl
    }
    if (requestUrl.origin === siteUrl.origin) {
      if (baseUrl === site.siteUrl) {
        return requestUrl
      }
      if (requestUrl.pathname.startsWith('/rest/')) {
        return new URL(`${baseUrl}${requestUrl.pathname}${requestUrl.search}`)
      }
      throw new JiraApiError('Scoped Jira attachments require a REST content URL.', null)
    }
  }
  // The gateway origin is shared by every tenant, so its full cloud-ID prefix must match.
  throw new JiraApiError('Jira attachment URL must use the configured site origin.', null)
}

export async function jiraRequestBinary(
  client: JiraClientForSite,
  pathOrUrl: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {}
): Promise<{ data: ArrayBuffer; contentType: string }> {
  const requestUrl = resolveBinaryRequestUrl(client.site, pathOrUrl)
  const headers = new Headers()
  // Binary attachments must not inherit JSON content negotiation.
  headers.set('Accept', '*/*')
  headers.set('User-Agent', JIRA_API_USER_AGENT)
  headers.set('Authorization', client.authorization)
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  try {
    const response = await jiraFetch(requestUrl.toString(), {
      headers,
      signal,
      ...(isJiraGatewayBaseUrl(apiBaseUrl(client.site)) ? { redirect: 'error' as const } : {})
    })
    if (!response.ok) {
      throw await toJiraError(response, requestUrl.toString())
    }
    const contentType = response.headers.get('content-type') || 'application/octet-stream'
    const bytes = await readFetchResponseBytesWithinLimit(
      response,
      options.maxBytes ?? 2 * 1024 * 1024
    )
    return {
      data: Uint8Array.from(bytes).buffer,
      contentType
    }
  } finally {
    // Cancelling the web body alone can leave Chromium's native request unfinished.
    controller.abort()
  }
}
