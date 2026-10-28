import { translate } from '@/i18n/i18n'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import type {
  JenkinsRebuildFailureReason,
  JenkinsRebuildMode,
  JenkinsRebuildResult
} from '../../../shared/jenkins-rebuild'
import { isJenkinsCheck } from '../../../shared/jenkins-rebuild'
import { asRecord } from '../../../shared/jenkins-payload'

/**
 * Starting a Jenkins build again, from the renderer's side.
 *
 * The IPC call carries the check's link and nothing else: the build number and its parameters are
 * resolved in the main process. A secret parameter value is masked before it reaches here, so
 * anything this module knew about the parameters would be the mask, and a rebuild that echoed it
 * back would POST `••••` at Jenkins.
 */

/**
 * Bounds the wait on the renderer side; the IPC call itself has no abort channel.
 *
 * Why sized to the main process's worst case rather than a round trip: the main side makes up to
 * three requests (build probe, crumb, POST) at 10s each, so a tighter bound would report a timeout
 * for a build that then starts.
 */
const JENKINS_REBUILD_TIMEOUT_MS = 45_000

/** Builds this client has a request in flight for, so two surfaces cannot start one build twice. */
const inFlightBuilds = new Set<string>()

export type JenkinsRebuildOutcome =
  | { ok: true; mode: JenkinsRebuildMode; message: string }
  | { ok: false; error: string }

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
        'jenkins.rebuild.noBuild',
        'This check does not link to a numbered Jenkins build, so there is nothing to rerun. Open it in Jenkins instead.'
      )
    case 'not-configured':
      return translate(
        'jenkins.rebuild.notConfigured',
        'Orca has no Jenkins server configured for {{value0}}. Add it in Settings → Integrations to rerun this build.',
        { value0: server }
      )
    case 'unauthorized':
      return translate(
        'jenkins.rebuild.unauthorized',
        'Jenkins rejected the saved credentials for {{value0}}. Update its API token in Settings → Integrations.',
        { value0: server }
      )
    case 'forbidden':
      return translate(
        'jenkins.rebuild.forbidden',
        'The saved Jenkins account cannot start builds on {{value0}}.',
        { value0: server }
      )
    case 'not-found':
      return translate(
        'jenkins.rebuild.notFound',
        'This Jenkins job or build is no longer available, so nothing was started.'
      )
    case 'unreachable':
      // Why hedged: a connection reset after the request was sent is classified the same way, and
      // that request may have started a build.
      return translate(
        'jenkins.rebuild.unreachable',
        'Could not reach {{value0}}. Check Jenkins before retrying, in case a build did start. Builds are triggered from this machine, so a Jenkins on another network stays out of reach.',
        { value0: server }
      )
    case 'timeout':
      return translate(
        'jenkins.rebuild.timeout',
        '{{value0}} did not respond in time. Check Jenkins before retrying, in case a build did start.',
        { value0: server }
      )
    case 'unconfirmed':
      return translate(
        'jenkins.rebuild.unconfirmed',
        'Jenkins did not confirm the new build. Check Jenkins before retrying, in case a build did start.'
      )
    case 'not-jenkins':
    case 'error':
      return translate('jenkins.rebuild.failed', 'Jenkins could not start a new build.')
  }
}

function successMessage(mode: JenkinsRebuildMode, omittedParameters: number): string {
  const started =
    mode === 'parameters'
      ? translate(
          'jenkins.rebuild.parametersStarted',
          'Jenkins started a new build with this build’s parameters'
        )
      : translate('jenkins.rebuild.buildStarted', 'Jenkins started a new build')
  // Why say it: a value Jenkins does not export cannot be replayed, and the new build runs with the
  // job's default instead — which is worth knowing when that default is not what failed.
  return omittedParameters > 0
    ? `${started}. ${translate(
        'jenkins.rebuild.omittedParameters',
        '{{value0}} parameter(s) stayed at the job’s default because Jenkins did not report their value.',
        { value0: omittedParameters }
      )}`
    : started
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
            'jenkins.rebuild.timedOut',
            'Timed out waiting for Jenkins to start the build. Check Jenkins before retrying, in case a build did start.'
          )
        )
      )
    }, JENKINS_REBUILD_TIMEOUT_MS)
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Start the build this check links to again, or explain why Orca cannot. */
export async function rebuildJenkinsCheck(check: PRCheckDetail): Promise<JenkinsRebuildOutcome> {
  const url = check.url
  if (!url || !isJenkinsCheck(check)) {
    return {
      ok: false,
      error: translate(
        'jenkins.rebuild.notJenkins',
        'This check does not link to a Jenkins build, so it cannot be rerun here.'
      )
    }
  }
  // Why the namespace check: a web client has no Jenkins namespace, and a partial `window.api`
  // (an embedder, or a test harness stubbing only what it exercises) has no proxy at all.
  if (!hasJenkinsApi()) {
    return {
      ok: false,
      error: translate(
        'jenkins.rebuild.unavailable',
        'Rerunning Jenkins builds is not available in this client.'
      )
    }
  }
  // Why here and not in each surface: the toolbar's menu and the per-check button are separate
  // affordances over the same build, and one click each would otherwise start it twice.
  if (inFlightBuilds.has(url)) {
    return {
      ok: false,
      error: translate(
        'jenkins.rebuild.inFlight',
        'A rerun of this Jenkins build is already starting.'
      )
    }
  }
  inFlightBuilds.add(url)
  try {
    const result = await callWithTimeout(window.api.jenkins.rebuild({ url }))
    if (!result) {
      return { ok: false, error: failureMessage('error', null) }
    }
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.reason, result.serverUrl) }
    }
    return {
      ok: true,
      mode: result.mode,
      message: successMessage(result.mode, result.omittedParameters)
    }
  } finally {
    inFlightBuilds.delete(url)
  }
}
