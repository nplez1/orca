import { jenkinsPost, readJenkinsCrumb } from './jenkins-write'
import { jenkinsGetJson } from './jenkins-request'
import type { JenkinsCredentialArgs } from './jenkins-request'
import { findJenkinsServerForUrl, readJenkinsServerToken } from './jenkins-server-store'
import type {
  JenkinsRebuildFailureReason,
  JenkinsRebuildResult
} from '../../shared/jenkins-rebuild'
import { asRecord, readString } from '../../shared/jenkins-payload'
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
    if (posted.status === 404 || posted.status === 409) {
      return classifyMissingReplay({
        serverUrl: location.serverUrl,
        request,
        buildUrl: location.buildUrl,
        message: posted.failure.message
      })
    }
    return fail(posted.failure.reason, location.serverUrl, posted.failure.message)
  }
  return { ok: true, buildNumber: location.buildNumber }
}

/**
 * Why a second request: `ReplayAction.getUrlName()` returns null unless the account may see the
 * action at all, and Stapler skips an action with no URL name — so a missing rerun is a 404, never a
 * 403. A freestyle job, a build a discarder pruned, a disabled job and an account without the Build
 * permission all look identical from there. One `api/json` on the build separates them.
 */
async function classifyMissingReplay(args: {
  serverUrl: string
  request: JenkinsCredentialArgs
  buildUrl: string
  message: string
}): Promise<JenkinsRebuildResult> {
  const probe = await jenkinsGetJson({
    ...args.request,
    url: `${args.buildUrl}api/json?tree=_class`
  })
  if (!probe.ok) {
    // Only a definite "no such build" is reported as missing; anything else could be a server we
    // cannot read right now, and claiming the build is gone would be a guess.
    return probe.failure.reason === 'not-found'
      ? fail('not-found', args.serverUrl, args.message)
      : fail('not-replayable', args.serverUrl, args.message)
  }
  const buildClass = readString(asRecord(probe.body)?._class) ?? ''
  // A freestyle build has no replay action by construction; nothing the user can change helps.
  if (!buildClass.includes('WorkflowRun')) {
    return fail('not-replayable', args.serverUrl, args.message)
  }
  // A pipeline run that does exist, so the action is missing for a permission or job-state reason.
  return fail('forbidden', args.serverUrl, `Jenkins offered no rerun for ${buildClass}`)
}
