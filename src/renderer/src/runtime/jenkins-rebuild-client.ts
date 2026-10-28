import { translate } from '@/i18n/i18n'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import type {
  JenkinsRebuildFailureReason,
  JenkinsRebuildResult
} from '../../../shared/jenkins-rebuild'
import { isJenkinsCheck } from '../../../shared/jenkins-rebuild'
import { asRecord } from '../../../shared/jenkins-payload'
import { parseJenkinsBuildLocation } from '../../../shared/jenkins-urls'

/**
 * Rerunning a Jenkins build, from the renderer's side.
 *
 * The IPC call carries the check's link and nothing else: Jenkins replays the build's own script and
 * copies its parameters on the server, so no parameter value — masked or otherwise — travels here.
 */

/**
 * Bounds the wait on the renderer side; the IPC call itself has no abort channel.
 *
 * Why sized to the main process's worst case rather than a round trip: the main side makes up to two
 * requests (crumb, then the replay) at 10s each.
 */
const JENKINS_RERUN_TIMEOUT_MS = 30_000

/** Builds this client has a request in flight for, so two surfaces cannot rerun one build twice. */
const inFlightBuilds = new Set<string>()

export type JenkinsRerunOutcome = { ok: true; message: string } | { ok: false; error: string }

/** Whether this client has a Jenkins surface at all; a web client has no `jenkins` namespace. */
export function hasJenkinsApi(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  // Why the record view: a harness or embedder can have no `window.api` at all, and `in` on
  // undefined throws — which reached React as a render error rather than as "not available".
  const api = asRecord(window.api)
  return api !== null && 'jenkins' in api
}

function failureMessage(reason: JenkinsRebuildFailureReason, serverUrl: string | null): string {
  const server = serverUrl ?? translate('jenkins.buildDetails.unknownServer', 'this Jenkins server')
  switch (reason) {
    case 'no-build':
      return translate(
        'jenkins.rerun.noBuild',
        'This check does not link to a numbered Jenkins build, so there is nothing to rerun. Open it in Jenkins instead.'
      )
    case 'not-replayable':
      return translate(
        'jenkins.rerun.notReplayable',
        'Jenkins has no rerun for this build: the job is a freestyle job rather than a pipeline, or it is disabled.'
      )
    case 'not-configured':
      return translate(
        'jenkins.rerun.notConfigured',
        'Orca has no Jenkins server configured for {{value0}}. Add it in Settings → Integrations to rerun this build.',
        { value0: server }
      )
    case 'unauthorized':
      return translate(
        'jenkins.rerun.unauthorized',
        'Jenkins rejected the saved credentials for {{value0}}. Update its API token in Settings → Integrations.',
        { value0: server }
      )
    case 'forbidden':
      return translate(
        'jenkins.rerun.forbidden',
        'Jenkins did not offer a rerun for this build on {{value0}}. The saved account needs the Build permission on the job.',
        { value0: server }
      )
    case 'not-found':
      return translate(
        'jenkins.rerun.notFound',
        'This Jenkins build is no longer available — build retention may have pruned it. Nothing was started.'
      )
    case 'unreachable':
      // Why hedged: a connection reset after the request was sent is classified the same way, and
      // that request may have started a build.
      return translate(
        'jenkins.rerun.unreachable',
        'Could not reach {{value0}}. Check Jenkins before retrying, in case a build did start. Builds are triggered from this machine, so a Jenkins on another network stays out of reach.',
        { value0: server }
      )
    case 'timeout':
      return translate(
        'jenkins.rerun.timeout',
        '{{value0}} did not respond in time. Check Jenkins before retrying, in case a build did start.',
        { value0: server }
      )
    case 'unconfirmed':
      return translate(
        'jenkins.rerun.unconfirmed',
        'Jenkins did not confirm the rerun. Check Jenkins before retrying, in case a build did start.'
      )
    case 'not-jenkins':
    case 'error':
      return translate('jenkins.rerun.failed', 'Jenkins could not rerun this build.')
  }
}

function successMessage(buildNumber: number | null): string {
  return buildNumber === null
    ? translate('jenkins.rerun.started', 'Jenkins is rerunning this build')
    : translate('jenkins.rerun.startedBuild', 'Jenkins is rerunning build #{{value0}}', {
        value0: buildNumber
      })
}

async function callWithTimeout(
  pending: Promise<JenkinsRebuildResult | undefined>
): Promise<JenkinsRebuildResult | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          translate(
            'jenkins.rerun.timedOut',
            'Timed out waiting for Jenkins to rerun the build. Check Jenkins before retrying, in case a build did start.'
          )
        )
      )
    }, JENKINS_RERUN_TIMEOUT_MS)
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Rerun the build this check links to, or explain why Orca cannot. */
export async function rerunJenkinsCheck(check: PRCheckDetail): Promise<JenkinsRerunOutcome> {
  const url = check.url
  const location = parseJenkinsBuildLocation(url)
  if (!url || location === null) {
    return {
      ok: false,
      error: translate(
        'jenkins.rerun.notJenkins',
        'This check does not link to a Jenkins build, so it cannot be rerun here.'
      )
    }
  }
  // Why its own answer: a link to `lastBuild` or to the job is Jenkins, but it names whichever build
  // is newest when it is read, so there is no specific build to rerun.
  if (!isJenkinsCheck(check)) {
    return { ok: false, error: failureMessage('no-build', location.serverUrl) }
  }
  // Why the namespace check: a web client has no Jenkins namespace, and a partial `window.api`
  // (an embedder, or a test harness stubbing only what it exercises) has no proxy at all.
  if (!hasJenkinsApi()) {
    return {
      ok: false,
      error: translate(
        'jenkins.rerun.unavailable',
        'Rerunning Jenkins builds is not available in this client.'
      )
    }
  }
  // Why the build URL and not the check's: one build reaches this surface twice (a legacy status
  // linking `…/42/display/redirect` and a Checks-plugin run linking `…/42/`), and keying on the raw
  // link would let each affordance rerun the same build.
  const buildUrl = location.buildUrl
  if (inFlightBuilds.has(buildUrl)) {
    return {
      ok: false,
      error: translate(
        'jenkins.rerun.inFlight',
        'A rerun of this Jenkins build is already starting.'
      )
    }
  }
  inFlightBuilds.add(buildUrl)
  try {
    const result = await callWithTimeout(window.api.jenkins.rerunBuild({ url }))
    if (!result) {
      return { ok: false, error: failureMessage('error', null) }
    }
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.reason, result.serverUrl) }
    }
    return { ok: true, message: successMessage(result.buildNumber) }
  } finally {
    inFlightBuilds.delete(buildUrl)
  }
}
