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
 * Three endpoints, preferred in this order because they differ in what they preserve:
 *
 * - `<build>/rebuild` replays the exact build, parameters and all, and is the only one that
 *   reproduces a build whose secret parameters the API does not return. It needs the rebuild
 *   plugin, so it is probed from the build's own `actions` and abandoned if the endpoint 404s.
 * - `<job>/buildWithParameters` starts a *new* build with the parameters read off the old one. It
 *   works on any Jenkins, which makes it the fallback rather than the third choice.
 * - `<job>/build` does the same for a job that takes no parameters.
 */

/** Only the fields that decide how this build can be started again. */
const REBUILD_PROBE_TREE = 'number,actions[_class,parameters[_class,name,value]]'

type RebuildPlan = {
  buildNumber: number
  parameters: { name: string; value: string }[]
  /** The rebuild plugin mirrors itself as an action on every build it can replay. */
  canReplay: boolean
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

/**
 * The plan a build payload describes.
 *
 * Null when the payload is not a build at all — a configured server answering with something else
 * is a broken Jenkins or a proxy wearing its URL, and guessing a build number from it would POST
 * to a job that never ran.
 */
function readRebuildPlan(body: unknown): RebuildPlan | null {
  const build = asRecord(body)
  const buildNumber = readFiniteNumber(build?.number)
  if (buildNumber === null) {
    return null
  }
  const parameters: { name: string; value: string }[] = []
  let canReplay = false
  for (const rawAction of readArray(build?.actions)) {
    const action = asRecord(rawAction)
    if (!action) {
      continue
    }
    // Why a substring match: the rebuild plugin's action is `hudson.plugins.rebuild.RebuildAction`,
    // and pinning the fully-qualified name would break on a plugin that moved its package.
    if ((readString(action._class) ?? '').toLowerCase().includes('rebuild')) {
      canReplay = true
    }
    for (const rawParameter of readArray(action.parameters)) {
      const parameter = asRecord(rawParameter)
      const name = readString(parameter?.name)
      if (name === null) {
        continue
      }
      parameters.push({ name, value: readString(parameter?.value) ?? '' })
    }
  }
  return { buildNumber, parameters, canReplay }
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
  const buildUrl = `${location.jobUrl}${plan.buildNumber}/`
  if (plan.canReplay) {
    const replay = await jenkinsPost({ ...request, crumb, url: `${buildUrl}rebuild` })
    if (replay.ok) {
      return { ok: true, mode: 'rebuild', buildNumber: plan.buildNumber }
    }
    // Why only a 404 falls through: the action on the build is evidence that the plugin is
    // installed, not proof, and "no such endpoint" is the one failure that means our guess was
    // wrong. A 403 or a 500 is the server refusing, and retrying on another endpoint would start
    // a second build the user did not ask for.
    if (replay.failure.reason !== 'not-found') {
      return failFrom(replay.failure, location.serverUrl)
    }
  }

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
    return failFrom(triggered.failure, location.serverUrl)
  }
  return {
    ok: true,
    mode: plan.parameters.length > 0 ? 'parameters' : 'build',
    buildNumber: plan.buildNumber
  }
}
