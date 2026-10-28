import { jenkinsPost, readJenkinsCrumb } from './jenkins-write'
import type { JenkinsCredentialArgs } from './jenkins-request'
import { findJenkinsServerForUrl, readJenkinsServerToken } from './jenkins-server-store'
import type {
  JenkinsRebuildFailureReason,
  JenkinsRebuildResult
} from '../../shared/jenkins-rebuild'
import { parseJenkinsBuildLocation } from '../../shared/jenkins-urls'

/**
 * Rerun a Jenkins build from a check's link.
 *
 * One endpoint, and it is the operation behind the "Rerun"/"Replay" button in Jenkins and in its
 * Blue Ocean dashboard: `POST <build>/replay/rebuild` reaches `ReplayAction.doRebuild`, which
 * replays the build's original script and copies its parameters and SCM revision. The Blue Ocean
 * route (`POST /blue/rest/organizations/<org>/pipelines/<pipeline>/runs/<id>/replay`) is the same
 * replay addressed by the pipeline rather than by the build, and it is not used here: a check's
 * link names the build, and the pipeline path and organization would have to be guessed from it.
 *
 * Why this and not `build`/`buildWithParameters`: those start a *new* build whose parameters have
 * to be reconstructed, and a secret parameter's value is masked before it ever reaches the
 * renderer — while a replay copies the run's own `ParametersAction` on the server. Nothing about
 * the parameters has to leave Jenkins.
 *
 * `POST <build>/replay/run` is the sibling endpoint and is deliberately not used: it reads the whole
 * script out of the submitted form, so a request without one replays nothing.
 */

function fail(
  reason: JenkinsRebuildFailureReason,
  serverUrl: string | null,
  message: string | null
): JenkinsRebuildResult {
  return { ok: false, reason, serverUrl, message }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function rerunJenkinsBuild(args: {
  url: string
  signal?: AbortSignal
}): Promise<JenkinsRebuildResult> {
  const location = parseJenkinsBuildLocation(args.url)
  if (!location) {
    return fail('not-jenkins', null, null)
  }
  // Why its own reason: a job-level link is Jenkins, but it names no build to rerun. Saying
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

  const request: JenkinsCredentialArgs = {
    username: server.username,
    apiToken,
    configured: true,
    serverBaseUrl: server.baseUrl,
    ...(args.signal ? { signal: args.signal } : {})
  }
  // Why the configured prefix rather than the build's: `serverUrl` is derived from the job path, so
  // a Jenkins served under a prefix deeper than the one the user declared would ask the wrong host
  // for a crumb. What the user configured is the Jenkins home.
  const crumb = await readJenkinsCrumb({ ...request, serverUrl: server.baseUrl })
  const posted = await jenkinsPost({ ...request, crumb, url: `${location.buildUrl}replay/rebuild` })
  if (!posted.ok) {
    if (posted.reason === 'unconfirmed') {
      return fail('unconfirmed', location.serverUrl, posted.message)
    }
    // Why 404 and 409 get their own answer: both mean this build has nothing to replay — a
    // freestyle job has no `ReplayAction` at all, and a job that can no longer be built refuses the
    // queue item. Reporting either as "no longer available" would send the user looking for a
    // build that is right there.
    if (posted.status === 404 || posted.status === 409) {
      return fail('not-replayable', location.serverUrl, posted.failure.message)
    }
    return fail(posted.failure.reason, location.serverUrl, posted.failure.message)
  }
  return { ok: true, buildNumber: location.buildNumber }
}
