import { jenkinsPost, readJenkinsCrumb } from './jenkins-write'
import {
  jenkinsGetJson,
  type JenkinsCredentialArgs,
  type JenkinsRequestFailure
} from './jenkins-request'
import { findJenkinsServerForUrl, readJenkinsServerToken } from './jenkins-server-store'
import type {
  JenkinsRebuildFailureReason,
  JenkinsRebuildResult
} from '../../shared/jenkins-rebuild'
import { asRecord, readArray, readFiniteNumber, readString } from '../../shared/jenkins-payload'
import { parseJenkinsBuildLocation } from '../../shared/jenkins-urls'

/**
 * Start a Jenkins build again from a check's link.
 *
 * One endpoint pair, both plugin-free: `<job>/buildWithParameters` when the build carried
 * parameters, `<job>/build` when it did not. Deliberately *not* the rebuild plugin's
 * `<build>/rebuild`, which replays the exact build: that action answers a parameterized build with
 * a redirect to a "fill in the parameters" form rather than starting anything, and a redirect is
 * indistinguishable from a queued build once it is followed. A reported "rebuilding" that started
 * nothing is worse than a new build that honestly says it is new.
 *
 * The parameters are read here, in the main process, and never from the renderer: a secret value is
 * masked before it reaches the renderer, so what the renderer holds is the mask.
 */

/** Only the fields that decide how this build can be started again. */
const REBUILD_PROBE_TREE = 'number,actions[_class,parameters[_class,name,value]]'

/** A parameter value Jenkins exported, or null when it did not export one. */
function readParameterValue(value: unknown): string | null {
  // Why the explicit types: a `BooleanParameterValue` exports `true`, and `String(true)` is the
  // "true" Jenkins parses back — while `''` would silently become `false`.
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value)
  }
  return null
}

type RebuildPlan = {
  buildNumber: number
  parameters: { name: string; value: string }[]
  /** Parameters whose value Jenkins did not export, so they stay at the job's default. */
  omittedParameters: number
}

/**
 * The plan a build payload describes.
 *
 * Null when the payload is not a build at all — a configured server answering with something else
 * is a broken Jenkins or a proxy wearing its URL, and guessing a build number from it would POST
 * at a job that never ran.
 */
function readRebuildPlan(body: unknown): RebuildPlan | null {
  const build = asRecord(body)
  const buildNumber = readFiniteNumber(build?.number)
  if (buildNumber === null) {
    return null
  }
  const parameters: { name: string; value: string }[] = []
  let omittedParameters = 0
  for (const rawAction of readArray(build?.actions)) {
    for (const rawParameter of readArray(asRecord(rawAction)?.parameters)) {
      const parameter = asRecord(rawParameter)
      const name = readString(parameter?.name)
      if (name === null) {
        continue
      }
      const value = readParameterValue(parameter?.value)
      if (value === null) {
        // Why omit rather than send `''`: an explicit empty value overrides the job's default, so a
        // password parameter that Jenkins does not export would be blanked instead of left alone.
        omittedParameters += 1
        continue
      }
      parameters.push({ name, value })
    }
  }
  return { buildNumber, parameters, omittedParameters }
}

function fail(
  reason: JenkinsRebuildFailureReason,
  serverUrl: string | null,
  message: string | null
): JenkinsRebuildResult {
  return { ok: false, reason, serverUrl, message }
}

function failFrom(failure: JenkinsRequestFailure, serverUrl: string): JenkinsRebuildResult {
  return fail(failure.reason, serverUrl, failure.message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function rebuildJenkinsBuild(args: {
  url: string
  signal?: AbortSignal
}): Promise<JenkinsRebuildResult> {
  const location = parseJenkinsBuildLocation(args.url)
  if (!location) {
    return fail('not-jenkins', null, null)
  }
  // Why its own reason: a job-level link is Jenkins, but it names no build to start again. Saying
  // `not-jenkins` there would tell the user their Jenkins link is not Jenkins.
  //
  // Why this also keeps a GitHub Actions link out: `…/actions/runs/1/job/456` parses as a job
  // called `456` with no build, so it lands here instead of being POSTed at as if it were one.
  if (!location.namesBuild) {
    return fail('no-build', location.serverUrl, null)
  }

  // Why a configured server is required rather than optional: a write needs that connection's
  // credentials, and an unconfigured host has none. Offering the action and then failing
  // anonymously is the behaviour this feature exists to remove.
  const server = findJenkinsServerForUrl(args.url)
  if (!server) {
    return fail('not-configured', location.serverUrl, null)
  }

  let apiToken: string | null
  try {
    apiToken = readJenkinsServerToken(server.id)
  } catch (error) {
    // A keychain denial is an auth problem the user can act on, not an unreachable server.
    return fail('unauthorized', location.serverUrl, errorMessage(error))
  }

  const request: JenkinsCredentialArgs & { signal?: AbortSignal } = {
    username: server.username,
    apiToken,
    configured: true,
    serverBaseUrl: server.baseUrl,
    ...(args.signal ? { signal: args.signal } : {})
  }

  const probe = await jenkinsGetJson({
    ...request,
    url: `${location.buildUrl}api/json?tree=${REBUILD_PROBE_TREE}`
  })
  if (!probe.ok) {
    return failFrom(probe.failure, location.serverUrl)
  }
  const plan = readRebuildPlan(probe.body)
  if (!plan) {
    return fail('error', location.serverUrl, 'Jenkins answered with something that is not a build')
  }

  // Why the configured prefix rather than the build's: `serverUrl` is derived from the job path, so
  // a Jenkins served under a prefix deeper than the one the user declared would ask the wrong host
  // for a crumb. What the user configured is the Jenkins home.
  const crumb = await readJenkinsCrumb({ ...request, serverUrl: server.baseUrl })
  const triggered = await jenkinsPost({
    ...request,
    crumb,
    url: `${location.jobUrl}${plan.parameters.length > 0 ? 'buildWithParameters' : 'build'}`,
    ...(plan.parameters.length > 0
      ? {
          body: new URLSearchParams(
            plan.parameters.map((parameter): [string, string] => [parameter.name, parameter.value])
          )
        }
      : {})
  })
  if (!triggered.ok) {
    return triggered.reason === 'unconfirmed'
      ? fail('unconfirmed', location.serverUrl, triggered.message)
      : failFrom(triggered.failure, location.serverUrl)
  }
  return {
    ok: true,
    mode: plan.parameters.length > 0 ? 'parameters' : 'build',
    buildNumber: plan.buildNumber,
    omittedParameters: plan.omittedParameters
  }
}
