import { translate } from '@/i18n/i18n'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import type {
  JenkinsRebuildFailureReason,
  JenkinsRebuildMode,
  JenkinsRebuildResult
} from '../../../shared/jenkins-rebuild'
import { isJenkinsCheck } from '../../../shared/jenkins-rebuild'

/**
 * Starting a Jenkins build again, from the renderer's side.
 *
 * The IPC call carries the check's link and nothing else: the build number, its parameters and
 * whether the build can be replayed are resolved in the main process. A secret parameter value is
 * masked before it reaches here, so anything this module knew about the parameters would be the
 * mask, and a rebuild that echoed it back would start a build with `••••` as its secret.
 */

/** Bounds the wait on the renderer side; the IPC call itself has no abort channel. */
const JENKINS_REBUILD_TIMEOUT_MS = 20_000

export type JenkinsRebuildOutcome =
  | { ok: true; mode: JenkinsRebuildMode; message: string }
  | { ok: false; error: string }

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
      return translate(
        'jenkins.rebuild.unreachable',
        'Could not reach {{value0}}, so nothing was started. Builds are triggered from this machine, so a Jenkins on another network stays out of reach.',
        { value0: server }
      )
    case 'timeout':
      return translate(
        'jenkins.rebuild.timeout',
        '{{value0}} did not respond in time. Check Jenkins before retrying, in case a build did start.',
        { value0: server }
      )
    case 'not-jenkins':
    case 'error':
      return translate('jenkins.rebuild.failed', 'Jenkins could not start a new build.')
  }
}

function successMessage(mode: JenkinsRebuildMode, buildNumber: number): string {
  switch (mode) {
    case 'rebuild':
      return translate('jenkins.rebuild.replayStarted', 'Jenkins is rebuilding build #{{value0}}', {
        value0: buildNumber
      })
    case 'parameters':
      return translate(
        'jenkins.rebuild.parametersStarted',
        'Jenkins started a new build with the same parameters'
      )
    case 'build':
      return translate('jenkins.rebuild.buildStarted', 'Jenkins started a new build')
  }
}

async function callWithTimeout(
  pending: Promise<JenkinsRebuildResult | undefined>
): Promise<JenkinsRebuildResult | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          translate('jenkins.rebuild.timedOut', 'Timed out waiting for Jenkins to start the build.')
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
  if (!('jenkins' in window.api)) {
    return {
      ok: false,
      error: translate(
        'jenkins.rebuild.unavailable',
        'Rerunning Jenkins builds is not available in this client.'
      )
    }
  }
  const result = await callWithTimeout(window.api.jenkins.rebuild({ url }))
  if (!result) {
    return { ok: false, error: failureMessage('error', null) }
  }
  if (!result.ok) {
    return { ok: false, error: failureMessage(result.reason, result.serverUrl) }
  }
  return { ok: true, mode: result.mode, message: successMessage(result.mode, result.buildNumber) }
}
