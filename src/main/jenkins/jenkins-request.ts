import { getMainHttpClient } from '../network/http-client'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import type { JenkinsBuildDetailsFailureReason } from '../../shared/jenkins-check-details'
import { isJenkinsUrlUnderBase } from '../../shared/jenkins-urls'

/**
 * Authenticated GETs against a Jenkins server.
 *
 * Jenkins answers its REST API over plain HTTP with basic auth, so this sits on the shared
 * main-process HTTP port (Chromium's stack on the desktop, which is what follows proxy and VPN
 * state) rather than the `gh`/`glab` CLI delegation the git providers use.
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
 * What the response says about whether this host really is Jenkins.
 *
 * `configured` is the user having added this URL as a Jenkins server, which makes its answers
 * authoritative: a 404 then means the build is gone, not that the URL was never Jenkins.
 */
export type JenkinsIdentityEvidence = {
  identifiedAsJenkins: boolean
  configured: boolean
}

function isKnownJenkins(evidence: JenkinsIdentityEvidence): boolean {
  return evidence.identifiedAsJenkins || evidence.configured
}

/**
 * Whether the response arrived from somewhere our credentials were not meant for.
 *
 * Why refuse it rather than read it: a Jenkins that redirects away from its own URL is an SSO
 * interstitial or a proxy, and that response is no longer evidence about this Jenkins. The Fetch
 * standard strips `Authorization` on a *cross-origin* hop, but a same-origin hop keeps it, so the
 * configured path prefix — not just the origin — is the boundary that matters here: a server
 * configured at `https://host/jenkins` redirecting to `https://host/other-service` is still the
 * same origin and would otherwise take the token with it.
 *
 * An unconfigured host has no prefix to compare against, so its own origin is the boundary.
 */
export function isResponseBeyondCredentialScope(args: {
  requestUrl: string
  responseUrl: string
  serverBaseUrl: string | null
}): boolean {
  if (args.responseUrl.length === 0) {
    // A synthetic or unpopulated `response.url` tells us nothing; do not invent a refusal.
    return false
  }
  if (args.serverBaseUrl !== null) {
    return !isJenkinsUrlUnderBase(args.serverBaseUrl, args.responseUrl)
  }
  try {
    return new URL(args.requestUrl).origin !== new URL(args.responseUrl).origin
  } catch {
    return false
  }
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
async function releaseBody(response: Response): Promise<void> {
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

export function classifyJenkinsHttpStatus(
  status: number,
  evidence: JenkinsIdentityEvidence
): JenkinsBuildDetailsFailureReason {
  if (status === 401) {
    return 'unauthorized'
  }
  if (status === 403) {
    return 'forbidden'
  }
  if (status === 404) {
    // Why: without either signal we cannot tell "no such build" from "not Jenkins at all", and
    // claiming a build is missing when the URL was never Jenkins would hide that distinction.
    return isKnownJenkins(evidence) ? 'not-found' : 'not-jenkins'
  }
  return isKnownJenkins(evidence) ? 'error' : 'not-jenkins'
}

export async function jenkinsGetJson(args: {
  url: string
  /** Empty when the server profile has no username; the token is then sent as a bearer token. */
  username: string
  /** Null for an unconfigured host, where only anonymous reads can succeed. */
  apiToken: string | null
  /** Whether the host matched a configured Jenkins server; see `JenkinsIdentityEvidence`. */
  configured?: boolean
  /** The matched server's configured prefix, which bounds where credentials may travel. */
  serverBaseUrl?: string | null
  signal?: AbortSignal
}): Promise<JenkinsRequestResult> {
  const httpClient = getMainHttpClient()
  const proxySession = httpClient.proxySession()
  // Why: a Jenkins behind a corporate proxy is the normal case for self-hosted instances, and the
  // shared transport only follows proxy state once it has been applied to the session.
  await ensureElectronProxyFromEnvironment({
    ...(proxySession ? { proxySession } : {}),
    probeUrl: args.url
  }).catch(() => undefined)

  const timeout = AbortSignal.timeout(JENKINS_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await httpClient.fetch(args.url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        ...(args.apiToken
          ? { Authorization: jenkinsAuthorizationHeader(args.username, args.apiToken) }
          : {})
      },
      signal: args.signal ? AbortSignal.any([args.signal, timeout]) : timeout
    })
  } catch (error) {
    return { ok: false, failure: classifyJenkinsTransportError(error) }
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
