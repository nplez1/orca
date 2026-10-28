import {
  applyJenkinsProxy,
  classifyJenkinsTransportError,
  jenkinsAuthHeaders,
  jenkinsGetJson,
  jenkinsSignal,
  releaseBody,
  type JenkinsCredentialArgs,
  type JenkinsRequestFailure
} from './jenkins-request'
import {
  classifyJenkinsHttpStatus,
  isKnownJenkins,
  isResponseBeyondCredentialScope,
  type JenkinsIdentityEvidence
} from './jenkins-response-verdict'
import { asRecord, readString } from '../../shared/jenkins-payload'
import { getMainHttpClient } from '../network/http-client'

/**
 * Writes against a Jenkins server.
 *
 * Kept apart from the read transport because a write's success is the status line, not a document:
 * a replay answers 302 back to the job page with no body, and a 201 with no `Location` is the normal
 * case rather than an empty result.
 */

export type JenkinsPostResult =
  | { ok: true; status: number }
  /**
   * `unconfirmed` is its own outcome: a redirect may mean the build was queued, and reporting it as
   * a failure would invite a retry that starts a second one.
   */
  | { ok: false; reason: 'unconfirmed'; message: string }
  | { ok: false; reason: 'failure'; status: number; failure: JenkinsRequestFailure }

/**
 * The CSRF field Jenkins requires on a write.
 *
 * `crumbIssuer` answers 404 when CSRF protection is off, which is the ordinary case for a
 * token-authenticated server and not a failure — null then means "send no crumb". Read per write
 * rather than cached: the field name is configurable, and a stale crumb is rejected with a 403 that
 * would read as an auth failure.
 */
export async function readJenkinsCrumb(
  args: JenkinsCredentialArgs & { serverUrl: string }
): Promise<{ field: string; value: string } | null> {
  const response = await jenkinsGetJson({
    ...args,
    url: `${args.serverUrl}/crumbIssuer/api/json`
  })
  if (!response.ok) {
    return null
  }
  const body = asRecord(response.body)
  const field = readString(body?.crumbRequestField)
  const value = readString(body?.crumb)
  return field !== null && value !== null ? { field, value } : null
}

export async function jenkinsPost(
  args: JenkinsCredentialArgs & {
    url: string
    /** Form body; omitted for an endpoint that takes no parameters. */
    body?: URLSearchParams
    crumb?: { field: string; value: string } | null
  }
): Promise<JenkinsPostResult> {
  await applyJenkinsProxy(args.url)

  let response: Response
  try {
    response = await getMainHttpClient().fetch(args.url, {
      method: 'POST',
      // Why follow rather than manual: the desktop transport is Electron's `net.fetch`, which
      // rejects a manual-redirect request outright. Following the redirect and comparing the
      // landing URL to the one we posted at is what both hosts can do, and the landing page is
      // never read as a verdict on the write (see the check below).
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        ...(args.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(args.crumb ? { [args.crumb.field]: args.crumb.value } : {}),
        ...jenkinsAuthHeaders(args)
      },
      ...(args.body ? { body: args.body.toString() } : {}),
      signal: jenkinsSignal(args.signal)
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'failure',
      status: 0,
      failure: classifyJenkinsTransportError(error)
    }
  }

  const jenkinsVersion = response.headers.get('x-jenkins')
  const evidence: JenkinsIdentityEvidence = {
    identifiedAsJenkins: jenkinsVersion !== null,
    configured: args.configured === true
  }
  // Why the scope check first: a redirect out of the configured prefix (an SSO interstitial, or a
  // proxy) is the one case where our credentials went somewhere they were not meant for. But a
  // write has already been sent by then, and Jenkins itself answers with `X-Jenkins` — so a landing
  // that identifies as Jenkins means the build was probably queued, and telling the user their
  // credentials were rejected would invite a retry that starts a second one.
  if (
    isResponseBeyondCredentialScope({
      requestUrl: args.url,
      responseUrl: response.url,
      serverBaseUrl: args.serverBaseUrl ?? null
    })
  ) {
    await releaseBody(response)
    if (jenkinsVersion !== null) {
      return {
        ok: false,
        reason: 'unconfirmed',
        message: `Jenkins redirected the answer outside its configured URL to ${response.url}`
      }
    }
    return {
      ok: false,
      reason: 'failure',
      status: response.status,
      failure: {
        reason: isKnownJenkins(evidence) ? 'unauthorized' : 'not-jenkins',
        message: `Jenkins redirected outside its configured URL to ${response.url}`,
        identifiedAsJenkins: evidence.identifiedAsJenkins,
        jenkinsVersion
      }
    }
  }
  // Why a redirect is not ambiguity here: a Jenkins write ends with `sendRedirect` as its normal
  // success path (the build is queued first), so the landing status is what decides. A landing
  // that answered 2xx is an accepted write however it got there; a landing that failed is the one
  // case we cannot read, because the POST itself may have been handled before the hop.
  const redirected = response.url.length > 0 && response.url !== args.url
  if (response.type === 'opaqueredirect' || response.status === 0) {
    await releaseBody(response)
    return {
      ok: false,
      reason: 'unconfirmed',
      message: `Jenkins redirected the build request to ${response.url || 'another page'}`
    }
  }
  if (!response.ok) {
    const status = response.status
    await releaseBody(response)
    return redirected
      ? {
          ok: false,
          reason: 'unconfirmed',
          message: `Jenkins redirected the build request to ${response.url}, which answered ${status}`
        }
      : {
          ok: false,
          reason: 'failure',
          status,
          failure: {
            reason: classifyJenkinsHttpStatus(status, evidence),
            message: `Jenkins responded ${status}${response.statusText ? ` ${response.statusText}` : ''}`,
            identifiedAsJenkins: evidence.identifiedAsJenkins,
            jenkinsVersion
          }
        }
  }
  await releaseBody(response)
  return { ok: true, status: response.status }
}
