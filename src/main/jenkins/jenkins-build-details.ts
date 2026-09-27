import type { PRCheckDetail } from '../../shared/github/check-types'
import {
  jenkinsBuildToCheckRunDetails,
  type JenkinsBuildDetailsFailureReason,
  type JenkinsBuildDetailsResult
} from '../../shared/jenkins-check-details'
import { parseJenkinsBuildLocation } from '../../shared/jenkins-urls'
import { asRecord } from '../../shared/jenkins-payload'
import { jenkinsGetJson, type JenkinsRequestFailure } from './jenkins-request'
import { findJenkinsServerForUrl, readJenkinsServerToken } from './jenkins-server-store'

/**
 * Read one Jenkins build as provider-neutral check details.
 *
 * Two GETs at most: `api/json` for the build, and `wfapi/describe` for the stage list. The second
 * is best-effort — a freestyle job has no stages, and an older server may not expose the endpoint.
 */

/** Only the fields the mapper reads, so a matrix build's `actions` cannot balloon the response. */
const JENKINS_BUILD_TREE = [
  'number',
  'building',
  'result',
  'displayName',
  'fullDisplayName',
  'description',
  'url',
  'timestamp',
  'duration',
  'estimatedDuration',
  'actions[_class,causes[_class,shortDescription],parameters[_class,name,value]]',
  'changeSets[items[commitId,msg,comment,author[fullName]]]'
].join(',')

function fail(
  reason: JenkinsBuildDetailsFailureReason,
  serverUrl: string | null,
  message: string | null
): JenkinsBuildDetailsResult {
  return { ok: false, reason, serverUrl, message }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A build payload always carries a number and a building flag; a random JSON API does not. */
function looksLikeJenkinsBuild(body: unknown): boolean {
  const record = asRecord(body)
  return typeof record?.number === 'number' && typeof record.building === 'boolean'
}

/**
 * Decide how much authority to give a failed request.
 *
 * With a configured server the answer is authoritative. Without one we are guessing from a URL
 * shape, so anything that could equally be "this URL is not Jenkins" degrades to `not-jenkins` and
 * lets the caller fall back to its own provider path — the difference between an empty pane and a
 * wrong one.
 */
function resolveFailure(
  failure: JenkinsRequestFailure,
  serverUrl: string,
  configured: boolean
): JenkinsBuildDetailsResult {
  if (configured || failure.identifiedAsJenkins) {
    return fail(failure.reason, serverUrl, failure.message)
  }
  switch (failure.reason) {
    case 'unauthorized':
    case 'forbidden':
      // Jenkins answered and wanted credentials we do not have for it.
      return fail('not-configured', serverUrl, failure.message)
    case 'not-found':
    case 'not-jenkins':
    case 'error':
      return fail('not-jenkins', serverUrl, failure.message)
    // A timeout or a transport failure is real information whatever the host turns out to be.
    case 'timeout':
    case 'unreachable':
    case 'not-configured':
      return fail(failure.reason, serverUrl, failure.message)
  }
}

export async function getJenkinsBuildDetails(args: {
  url: string
  check: Pick<PRCheckDetail, 'name' | 'status' | 'conclusion' | 'url'>
  signal?: AbortSignal
}): Promise<JenkinsBuildDetailsResult> {
  const location = parseJenkinsBuildLocation(args.url)
  if (!location) {
    return fail('not-jenkins', null, null)
  }
  const server = findJenkinsServerForUrl(args.url)
  let apiToken: string | null = null
  if (server) {
    try {
      apiToken = readJenkinsServerToken(server.id)
    } catch (error) {
      // A keychain denial is an auth problem the user can act on, not an unreachable server.
      return fail('unauthorized', location.serverUrl, errorMessage(error))
    }
  }

  const request = {
    username: server?.username ?? '',
    apiToken,
    configured: server !== null,
    serverBaseUrl: server?.baseUrl ?? null,
    ...(args.signal ? { signal: args.signal } : {})
  }
  const buildResponse = await jenkinsGetJson({
    ...request,
    url: `${location.buildUrl}api/json?tree=${JENKINS_BUILD_TREE}`
  })
  if (!buildResponse.ok) {
    return resolveFailure(buildResponse.failure, location.serverUrl, server !== null)
  }
  // Why for both cases: a configured server answering with something that is not a build is a
  // broken Jenkins or a proxy wearing its URL, and rendering that as an empty pane is the bug this
  // feature removes. An unconfigured host gets the benefit of the doubt and falls through.
  if (!looksLikeJenkinsBuild(buildResponse.body)) {
    return server === null
      ? fail('not-jenkins', location.serverUrl, null)
      : fail('error', location.serverUrl, 'Jenkins answered with something that is not a build')
  }

  const stagesResponse = await jenkinsGetJson({
    ...request,
    url: `${location.buildUrl}wfapi/describe`
  })
  return {
    ok: true,
    details: jenkinsBuildToCheckRunDetails({
      check: args.check,
      location,
      build: buildResponse.body,
      stages: stagesResponse.ok ? stagesResponse.body : null
    })
  }
}
