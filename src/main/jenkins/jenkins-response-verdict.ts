import type { JenkinsBuildDetailsFailureReason } from '../../shared/jenkins-check-details'
import { isJenkinsUrlUnderBase } from '../../shared/jenkins-urls'

/**
 * What a Jenkins response is evidence of.
 *
 * Every request to a Jenkins URL is a guess about an address the renderer supplied, so the answer
 * has to distinguish "this build is gone" from "this was never Jenkins" before anything is shown —
 * or, for a write, before anything is started.
 */

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

export function isKnownJenkins(evidence: JenkinsIdentityEvidence): boolean {
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
