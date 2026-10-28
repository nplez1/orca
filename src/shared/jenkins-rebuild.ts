import type { PRCheckDetail } from './github/check-types'
import type { JenkinsBuildDetailsFailureReason } from './jenkins-check-details'
import { parseJenkinsBuildLocation } from './jenkins-urls'
import { parseActionsRunId } from './actions-run-url'

/**
 * Starting a Jenkins build again from the Checks surface.
 *
 * A Jenkins check arrives as a GitHub legacy commit status — a name, a state and a `target_url`
 * with no run identifier — so the link is the only handle there is. Everything provider-specific
 * (the build number, its parameters, whether the rebuild plugin is installed) is resolved in the
 * main process from that link, and never round-tripped through the renderer: a secret parameter
 * value is masked before it reaches the renderer, so replaying the masked copy would start a build
 * with the literal mask.
 */

/**
 * How the new build was started, which is what the confirmation copy says.
 *
 * `rebuild` replays the exact build; the other two start a *new* build, so the copy must not claim
 * they are the same run.
 */
export type JenkinsRebuildMode = 'rebuild' | 'parameters' | 'build'

export type JenkinsRebuildFailureReason =
  | JenkinsBuildDetailsFailureReason
  /** The link names a job or a permalink rather than a build that can be read back. */
  | 'no-build'

export type JenkinsRebuildResult =
  | { ok: true; mode: JenkinsRebuildMode; buildNumber: number }
  | {
      ok: false
      reason: JenkinsRebuildFailureReason
      /** Origin of the Jenkins the check pointed at, so copy can name the server involved. */
      serverUrl: string | null
      /** Provider or transport detail; the renderer localizes its own copy. */
      message: string | null
    }

/**
 * Whether a check is a Jenkins build Orca can act on, decided by the only handle Jenkins gives us.
 *
 * Why `namesBuild`: `parseJenkinsBuildLocation` is deliberately permissive — it answers "could this be
 * a Jenkins build", which the details path then confirms with a request. A GitHub Actions check URL
 * (`…/actions/runs/123/job/456`) parses as a job named `456` with no build, so treating that as
 * Jenkins here would send a GitHub check to a Jenkins server.
 */
export function isJenkinsCheck(check: Pick<PRCheckDetail, 'url'>): boolean {
  const location = parseJenkinsBuildLocation(check.url)
  return location !== null && location.namesBuild
}

/** A check whose outcome is worth rerunning — the same set GitHub's `failedOnly` selects. */
export function isRerunnableFailure(check: Pick<PRCheckDetail, 'conclusion'>): boolean {
  return (
    check.conclusion === 'failure' ||
    check.conclusion === 'cancelled' ||
    check.conclusion === 'timed_out'
  )
}

/**
 * Whether GitHub Actions has anything to rerun on this check.
 *
 * Mirrors the candidate rule in the main process (`rerun-pr-checks.ts`), because a mixed list has
 * to be split before either provider is called: asking GitHub about a Jenkins-only list is what
 * produced "No failed GitHub Actions checks to rerun."
 */
export function isGitHubRerunCandidate(check: PRCheckDetail): boolean {
  if (isJenkinsCheck(check)) {
    return false
  }
  return (
    typeof check.workflowRunId === 'number' ||
    typeof check.checkRunId === 'number' ||
    parseActionsRunId(check.url) !== undefined
  )
}

/** A mixed failure list, split by the provider that owns each check. */
export function selectRerunTargets({
  checks,
  failedOnly
}: {
  checks: PRCheckDetail[]
  failedOnly: boolean
}): { jenkins: PRCheckDetail[]; github: PRCheckDetail[] } {
  const candidates = failedOnly ? checks.filter(isRerunnableFailure) : checks
  return {
    jenkins: candidates.filter(isJenkinsCheck),
    github: candidates.filter(isGitHubRerunCandidate)
  }
}
