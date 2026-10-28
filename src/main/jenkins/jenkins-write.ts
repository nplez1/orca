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
 * `build`, `buildWithParameters` and the rebuild plugin all answer a POST whose body nobody reads,
 * and a 201 with no `Location` is the normal case rather than an empty result.
 */

export type JenkinsPostResult =
  | { ok: true; status: number }
  | { ok: false; failure: JenkinsRequestFailure }

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
      // Why follow: Jenkins answers a successful trigger with 201 + Location, and the rebuild
      // plugin with a 302 to the new build. Neither is ours to read; what matters is that the
      // write was accepted rather than refused.
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
    return { ok: false, failure: classifyJenkinsTransportError(error) }
  }

  const jenkinsVersion = response.headers.get('x-jenkins')
  const evidence: JenkinsIdentityEvidence = {
    identifiedAsJenkins: jenkinsVersion !== null,
    configured: args.configured === true
  }
  if (
    isResponseBeyondCredentialScope({
      requestUrl: args.url,
      responseUrl: response.url,
      serverBaseUrl: args.serverBaseUrl ?? null
    })
  ) {
    await releaseBody(response)
    return {
      ok: false,
      failure: {
        reason: isKnownJenkins(evidence) ? 'unauthorized' : 'not-jenkins',
        message: `Jenkins redirected outside its configured URL to ${response.url}`,
        identifiedAsJenkins: evidence.identifiedAsJenkins,
        jenkinsVersion
      }
    }
  }
  if (!response.ok) {
    const status = response.status
    await releaseBody(response)
    return {
      ok: false,
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
