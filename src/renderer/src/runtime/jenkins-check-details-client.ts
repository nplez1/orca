import { translate } from '@/i18n/i18n'
import type { PRCheckRunDetails, PRCheckDetail } from '../../../shared/github/check-types'
import type {
  JenkinsBuildDetailsFailureReason,
  JenkinsBuildDetailsResult
} from '../../../shared/jenkins-check-details'
import { parseJenkinsBuildLocation } from '../../../shared/jenkins-urls'
import { JenkinsCheckDetailsError } from '@/lib/check-details-error-action'

/**
 * Jenkins build details for a check, picked by the check's own URL.
 *
 * A Jenkins check reaches the panel as a GitHub legacy commit status — a name, a state and a
 * `target_url`, with no run identifier — so unlike GitHub Actions and GitLab there is nothing to
 * dispatch on except the URL, and no identifier to hand a provider-specific API.
 */

/** The IPC call has no abort channel, so this bounds the wait on the renderer side. */
const JENKINS_DETAILS_TIMEOUT_MS = 25_000

function failureMessage(
  reason: JenkinsBuildDetailsFailureReason,
  serverUrl: string | null
): string {
  const server = serverUrl ?? translate('jenkins.buildDetails.unknownServer', 'this Jenkins server')
  switch (reason) {
    case 'not-configured':
      return translate(
        'jenkins.buildDetails.notConfigured',
        'Orca has no Jenkins server configured for {{value0}}. Add it in Settings → Integrations to see build details.',
        { value0: server }
      )
    case 'unauthorized':
      return translate(
        'jenkins.buildDetails.unauthorized',
        'Jenkins rejected the saved credentials for {{value0}}. Update its API token in Settings → Integrations.',
        { value0: server }
      )
    case 'forbidden':
      return translate(
        'jenkins.buildDetails.forbidden',
        'The saved Jenkins account cannot read this job on {{value0}}.',
        { value0: server }
      )
    case 'not-found':
      return translate(
        'jenkins.buildDetails.notFound',
        'This Jenkins build is no longer available. Build retention may have pruned it.'
      )
    case 'unreachable':
      return translate(
        'jenkins.buildDetails.unreachable',
        'Could not reach {{value0}}. Build details are read from this machine, so a Jenkins on another network stays out of reach.',
        { value0: server }
      )
    case 'timeout':
      return translate('jenkins.buildDetails.timeout', '{{value0}} did not respond in time.', {
        value0: server
      })
    case 'not-jenkins':
    case 'error':
      return translate('jenkins.buildDetails.failed', 'Jenkins could not return this build.')
  }
}

async function callWithTimeout(
  pending: Promise<JenkinsBuildDetailsResult | undefined>
): Promise<JenkinsBuildDetailsResult | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          translate('jenkins.buildDetails.timedOut', 'Timed out loading this Jenkins build.')
        )
      )
    }, JENKINS_DETAILS_TIMEOUT_MS)
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Details for a check that Jenkins owns, or null when another provider owns it.
 *
 * Throws with an explanation the user can act on (no server configured, rejected credentials,
 * unreachable host) so the surface's existing error state carries it instead of falling through to
 * "no inline details are available".
 */
export async function loadJenkinsCheckDetails(
  check: PRCheckDetail
): Promise<PRCheckRunDetails | null> {
  const url = check.url
  if (!url || parseJenkinsBuildLocation(url) === null) {
    return null
  }
  // Why the widened type: a web client has no Jenkins namespace, and its fallback proxy resolves
  // every call to undefined rather than throwing.
  const result: JenkinsBuildDetailsResult | undefined = await callWithTimeout(
    window.api.jenkins.buildDetails({
      url,
      checkName: check.name,
      status: check.status,
      conclusion: check.conclusion
    })
  )
  if (!result) {
    return null
  }
  if (result.ok) {
    return result.details
  }
  if (result.reason === 'not-jenkins') {
    return null
  }
  // Why typed: the reason decides whether the surface offers a Settings link, and the localized
  // message alone cannot say that.
  throw new JenkinsCheckDetailsError(
    result.reason,
    result.serverUrl,
    failureMessage(result.reason, result.serverUrl)
  )
}

/**
 * Jenkins details when it owns the check, otherwise the caller's own provider path.
 *
 * `loadOwnProviderDetails` is lazy so the GitHub request is never issued for a check Jenkins
 * already answered.
 */
export async function loadCheckDetailsWithProviderFallback(
  check: PRCheckDetail,
  loadOwnProviderDetails: () => Promise<PRCheckRunDetails | null>
): Promise<PRCheckRunDetails | null> {
  return (await loadJenkinsCheckDetails(check)) ?? loadOwnProviderDetails()
}
