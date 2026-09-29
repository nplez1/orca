import type { JenkinsBuildDetailsFailureReason } from '../../../shared/jenkins-check-details'

/**
 * A check-details failure the user can fix elsewhere, carried alongside the message.
 *
 * Why a serializable descriptor rather than a callback: the pane and the full-details tab keep
 * this in their state (and the tab state is persisted), so it has to survive a round trip.
 */
export type CheckDetailsErrorAction = { kind: 'open-jenkins-settings' }

/** Failures that mean "Jenkins is not set up for this build", not "the build went wrong". */
const JENKINS_SETTINGS_REASONS: ReadonlySet<JenkinsBuildDetailsFailureReason> = new Set([
  'not-configured',
  'unauthorized',
  'forbidden'
])

/**
 * A Jenkins read failure that keeps its machine-readable reason.
 *
 * Why not a bare `Error`: the message is localized at throw time, so the reason is gone by the
 * time a surface decides whether to offer a settings link. The class carries it forward.
 */
export class JenkinsCheckDetailsError extends Error {
  readonly reason: JenkinsBuildDetailsFailureReason
  readonly serverUrl: string | null

  constructor(reason: JenkinsBuildDetailsFailureReason, serverUrl: string | null, message: string) {
    super(message)
    this.name = 'JenkinsCheckDetailsError'
    this.reason = reason
    this.serverUrl = serverUrl
  }
}

/** The settings affordance a thrown error calls for, or null when only copy is useful. */
export function checkDetailsErrorAction(error: unknown): CheckDetailsErrorAction | null {
  return error instanceof JenkinsCheckDetailsError && JENKINS_SETTINGS_REASONS.has(error.reason)
    ? { kind: 'open-jenkins-settings' }
    : null
}
