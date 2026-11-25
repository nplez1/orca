import { getMainHttpClient } from '../network/http-client'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import type { JenkinsBuildDetailsFailureReason } from '../../shared/jenkins-check-details'
import { isJenkinsUrlUnderBase } from '../../shared/jenkins-urls'
import {
  classifyJenkinsHttpStatus,
  isKnownJenkins,
  isResponseBeyondCredentialScope,
  type JenkinsIdentityEvidence
} from './jenkins-response-verdict'

export {
  classifyJenkinsHttpStatus,
  isResponseBeyondCredentialScope,
  type JenkinsIdentityEvidence
} from './jenkins-response-verdict'

/**
 * The transport every Jenkins request goes through: authenticated, proxied, bounded.
 *
 * Jenkins answers its REST API over plain HTTP with basic auth, so this sits on the shared
 * main-process HTTP port (Chromium's stack on the desktop, which is what follows proxy and VPN
 * state) rather than the `gh`/`glab` CLI delegation the git providers use. `jenkinsGetJson` reads
 * with it; `jenkins-write.ts` posts with it.
 */

/** Jenkins answers quickly or not at all; a hung server must not hold the Checks pane open. */
const JENKINS_REQUEST_TIMEOUT_MS = 10_000

export type JenkinsRequestFailure = {
  reason: JenkinsBuildDetailsFailureReason
  message: string
  /**
   * Whether Jenkins identified itself in the response headers. Only ever used as positive evidence:
   * SSO and proxies strip `X-Jenkins`, so its absence proves nothing.
   */
  identifiedAsJenkins: boolean
  /** `X-Jenkins` header value, e.g. `2.452.1`, when the server sent one. */
  jenkinsVersion: string | null
}

/**
 * How much of a response this client will read.
 *
 * The URL is renderer-supplied, so the response size is not ours to trust; `api/json` on a job with
 * a deep change set is the realistic large case, not the pathological one.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) {
    return response.text()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!value) {
        continue
      }
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Cancelled or already released; the chunks we hold are what matters.
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

export type JenkinsRequestResult =
  | { ok: true; body: unknown; identifiedAsJenkins: boolean; jenkinsVersion: string | null }
  | { ok: false; failure: JenkinsRequestFailure }

/**
 * Why basic auth with the token as the password: that is the documented Jenkins form. A server
 * saved without a username falls back to a bearer token.
 */
export function jenkinsAuthorizationHeader(username: string, apiToken: string): string {
  return username
    ? `Basic ${Buffer.from(`${username}:${apiToken}`).toString('base64')}`
    : `Bearer ${apiToken}`
}

function failure(
  reason: JenkinsBuildDetailsFailureReason,
  message: string,
  identifiedAsJenkins = false,
  jenkinsVersion: string | null = null
): JenkinsRequestResult {
  return { ok: false, failure: { reason, message, identifiedAsJenkins, jenkinsVersion } }
}

/** A response body nobody reads still has to be released; undici can crash the host otherwise. */
export async function releaseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Already consumed or unsupported; nothing is owed to the socket either way.
  }
}

/**
 * Turn a transport error into a verdict.
 *
 * A timeout and a caller abort collapse into one reason because both mean "no answer in time" to
 * the person waiting, and neither is evidence about the server.
 */
export function classifyJenkinsTransportError(error: unknown): JenkinsRequestFailure {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { reason: 'timeout', message, identifiedAsJenkins: false, jenkinsVersion: null }
  }
  // Why not swallow the message: a self-signed certificate or a DNS failure is the whole
  // explanation for "I cannot see my build", and it names no credential.
  return { reason: 'unreachable', message, identifiedAsJenkins: false, jenkinsVersion: null }
}

/** The credentials half of every Jenkins request; null `apiToken` means an anonymous read. */
export type JenkinsCredentialArgs = {
  /** Empty when the server profile has no username; the token is then sent as a bearer token. */
  username: string
  /** Null for an unconfigured host, where only anonymous reads can succeed. */
  apiToken: string | null
  /** Whether the host matched a configured Jenkins server; see `JenkinsIdentityEvidence`. */
  configured?: boolean
  /** The matched server's configured prefix, which bounds where credentials may travel. */
  serverBaseUrl?: string | null
  /**
   * Refuse a redirect instead of following it.
   *
   * Why: `follow` sends the next request wherever the status points, and a public host answering
   * `302 Location: http://10.0.0.5/…` is the intranet probe an unconfigured host may not make.
   * Every hop can be vetted only through `net.request` (see `electron-repo-icon-fetch.ts`), and a
   * redirect from a host nobody configured is not worth that transport — so an unconfigured host is
   * read only when it answers directly.
   */
  refuseRedirects?: boolean
  signal?: AbortSignal
}

/**
 * Points the shared transport at the proxy the environment describes.
 *
 * Why: a Jenkins behind a corporate proxy is the normal case for self-hosted instances, and the
 * shared transport only follows proxy state once it has been applied to the session.
 */
export async function applyJenkinsProxy(url: string): Promise<void> {
  const proxySession = getMainHttpClient().proxySession()
  await ensureElectronProxyFromEnvironment({
    ...(proxySession ? { proxySession } : {}),
    probeUrl: url
  }).catch(() => undefined)
}

export function jenkinsAuthHeaders(args: JenkinsCredentialArgs): Record<string, string> {
  return args.apiToken
    ? { Authorization: jenkinsAuthorizationHeader(args.username, args.apiToken) }
    : {}
}

export function jenkinsSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(JENKINS_REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** A redirect status; only the class matters, and only to the refusal below. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Hops a configured Jenkins may redirect through.
 *
 * A build permalink legitimately redirects to the build it names, so one refusal is too strict; five
 * is more than any real chain needs and still bounded.
 */
const MAX_JENKINS_REDIRECTS = 5

/** The request asked for a URL outside the server the credentials belong to, so none were sent. */
export function jenkinsScopeRefusal(url: string, serverBaseUrl: string | null): string | null {
  if (serverBaseUrl === null) {
    return null
  }
  return isJenkinsUrlUnderBase(serverBaseUrl, url)
    ? null
    : `${url} is outside the Jenkins server configured at ${serverBaseUrl}`
}

/**
 * Whether the next hop may receive the token.
 *
 * Why per hop and not after the fact: the Fetch standard strips `Authorization` on a cross-origin
 * hop but keeps it on a same-origin one, so a server configured at `https://host/jenkins` answering
 * `302 /other-service` takes the token with it. Checking the landing URL can then only refuse to
 * read an answer the token already fetched. A scheme change is a different origin and so is refused
 * by the same rule.
 */
function vettedRedirectTarget(
  from: string,
  location: string,
  serverBaseUrl: string | null,
  requestUrl: string
): string | null {
  let target: URL
  try {
    target = new URL(location, from)
  } catch {
    return null
  }
  const beyond = isResponseBeyondCredentialScope({
    requestUrl,
    responseUrl: target.href,
    serverBaseUrl
  })
  return beyond ? null : target.href
}

/** A hop the credentials may not follow; reported rather than sent. */
class JenkinsRedirectScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JenkinsRedirectScopeError'
  }
}

/**
 * One authenticated read, following only the redirects the credentials are allowed to reach.
 *
 * Why a manual loop rather than `redirect: 'follow'`: see `vettedRedirectTarget`. An unconfigured
 * host is never followed at all (see `refuseRedirects`), and a host whose transport cannot expose
 * hops falls back to `follow` plus the post-hoc check, which is what it had before.
 */
async function fetchJenkinsReadRefusingForeignHops(
  args: JenkinsCredentialArgs & { url: string },
  init: RequestInit
): Promise<Response> {
  const httpClient = getMainHttpClient()
  const hopFetch = httpClient.fetchManualRedirects
  if (args.refuseRedirects === true || !hopFetch) {
    return httpClient.fetch(args.url, {
      ...init,
      redirect: args.refuseRedirects === true ? 'manual' : 'follow'
    })
  }
  let url = args.url
  for (let hop = 0; ; hop += 1) {
    const response = await hopFetch(url, init)
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response
    }
    const location = response.headers.get('location')
    await releaseBody(response)
    const target =
      location && hop < MAX_JENKINS_REDIRECTS
        ? vettedRedirectTarget(url, location, args.serverBaseUrl ?? null, args.url)
        : null
    if (target === null) {
      throw new JenkinsRedirectScopeError(
        `Jenkins redirected outside its configured URL to ${location ?? 'an unknown location'}`
      )
    }
    url = target
  }
}

function redirectFailure(): JenkinsRequestFailure {
  return {
    reason: 'not-configured',
    message: 'Jenkins redirected, and an unconfigured host is only read when it answers directly',
    identifiedAsJenkins: false,
    jenkinsVersion: null
  }
}

/**
 * Electron's transport rejects a manual redirect instead of handing back the 3xx response
 * (`net-client-request.ts`): the request is already cancelled when it reaches us, which is a
 * refusal, not an unreachable server. The message is Electron's own, matched verbatim — in `manual`
 * mode Chromium cancels on the first hop, so no `ERR_TOO_MANY_REDIRECTS` reaches this branch.
 */
function isCancelledRedirect(error: unknown): boolean {
  return error instanceof Error && /redirect was cancelled/i.test(error.message)
}

export async function jenkinsGetJson(
  args: JenkinsCredentialArgs & { url: string }
): Promise<JenkinsRequestResult> {
  await applyJenkinsProxy(args.url)
  // Why before the request: `api/json` on a build whose URL came from a commit status will carry the
  // token wherever that URL points, and the post-response check can only refuse an answer the token
  // already fetched.
  const outsideScope = jenkinsScopeRefusal(args.url, args.serverBaseUrl ?? null)
  if (outsideScope !== null) {
    return failure(args.configured === true ? 'not-jenkins' : 'not-configured', outsideScope)
  }

  const init: RequestInit = {
    method: 'GET',
    headers: { Accept: 'application/json', ...jenkinsAuthHeaders(args) },
    signal: jenkinsSignal(args.signal)
  }
  let response: Response
  try {
    response = await fetchJenkinsReadRefusingForeignHops(args, init)
  } catch (error) {
    if (error instanceof JenkinsRedirectScopeError) {
      return failure(args.configured === true ? 'unauthorized' : 'not-configured', error.message)
    }
    if (args.refuseRedirects && isCancelledRedirect(error)) {
      return { ok: false, failure: redirectFailure() }
    }
    return { ok: false, failure: classifyJenkinsTransportError(error) }
  }
  if (args.refuseRedirects && REDIRECT_STATUSES.has(response.status)) {
    await releaseBody(response)
    return { ok: false, failure: redirectFailure() }
  }

  const jenkinsVersion = response.headers.get('x-jenkins')
  const evidence: JenkinsIdentityEvidence = {
    identifiedAsJenkins: jenkinsVersion !== null,
    configured: args.configured === true
  }
  const identifiedAsJenkins = evidence.identifiedAsJenkins
  if (
    isResponseBeyondCredentialScope({
      requestUrl: args.url,
      responseUrl: response.url,
      serverBaseUrl: args.serverBaseUrl ?? null
    })
  ) {
    await releaseBody(response)
    return failure(
      isKnownJenkins(evidence) ? 'unauthorized' : 'not-jenkins',
      `Jenkins redirected outside its configured URL to ${response.url}`,
      identifiedAsJenkins,
      jenkinsVersion
    )
  }
  if (!response.ok) {
    await releaseBody(response)
    return failure(
      classifyJenkinsHttpStatus(response.status, evidence),
      `Jenkins responded ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      identifiedAsJenkins,
      jenkinsVersion
    )
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('json')) {
    // A 200 that is not JSON is a login page (SSO) or some other application wearing this URL.
    await releaseBody(response)
    return failure(
      isKnownJenkins(evidence) ? 'unauthorized' : 'not-jenkins',
      'Jenkins returned a non-JSON response',
      identifiedAsJenkins,
      jenkinsVersion
    )
  }

  try {
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES)
    if (text === null) {
      return failure(
        isKnownJenkins(evidence) ? 'error' : 'not-jenkins',
        'Jenkins returned more data than Orca will read',
        identifiedAsJenkins,
        jenkinsVersion
      )
    }
    const body: unknown = JSON.parse(text)
    return { ok: true, body, identifiedAsJenkins, jenkinsVersion }
  } catch (error) {
    // Why `configured` again: a configured server that answers with unparseable JSON is a broken
    // Jenkins, not proof that this is somebody else's API — falling through would hide it.
    return failure(
      isKnownJenkins(evidence) ? 'error' : 'not-jenkins',
      error instanceof Error ? error.message : String(error),
      identifiedAsJenkins,
      jenkinsVersion
    )
  }
}
