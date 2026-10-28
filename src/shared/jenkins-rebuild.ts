import type { PRCheckDetail } from './github/check-types'
import type { JenkinsBuildDetailsFailureReason } from './jenkins-check-details'
import { parseJenkinsBuildLocation } from './jenkins-urls'
import { parseActionsRunId } from './actions-run-url'

/**
 * Starting a Jenkins build again from the Checks surface.
 *
 * A Jenkins check arrives as a GitHub legacy commit status — a name, a state and a `target_url`
 * with no run identifier — so the link is the only handle there is. A Jenkins that publishes
 * GitHub check runs instead (the Checks plugin) carries a `checkRunId` too, which is why the
 * GitHub rerun path has to leave these checks alone: rerequesting such a check run starts a build
 * on the Jenkins side, and this module would start a second one.
 *
 * Everything provider-specific — the build number, its parameters — is resolved in the main
 * process from that link and never round-tripped through the renderer: a secret parameter value is
 * masked before it reaches the renderer, so replaying the masked copy would POST `••••` at Jenkins.
 */

/** How the new build was started, which is what the confirmation copy says. */
export type JenkinsRebuildMode = 'parameters' | 'build'

export type JenkinsRebuildFailureReason =
  | JenkinsBuildDetailsFailureReason
  /** The link names a job or a permalink rather than a build that can be read back. */
  | 'no-build'
  /** Jenkins answered with a redirect, so whether a build started cannot be read from it. */
  | 'unconfirmed'

export type JenkinsRebuildResult =
  | {
      ok: true
      mode: JenkinsRebuildMode
      buildNumber: number
      /** Parameters sent from the previous build. */
      sentParameters: number
      /** Parameters left at the job's default because Jenkins did not export a value for them. */
      omittedParameters: number
    }
  | {
      ok: false
      reason: JenkinsRebuildFailureReason
      /** Origin of the Jenkins the check pointed at, so copy can name the server involved. */
      serverUrl: string | null
      /** Provider or transport detail; the renderer localizes its own copy. */
      message: string | null
    }

/**
 * Whether a check is a Jenkins build Orca can rerun, decided by the only handle Jenkins gives us.
 *
 * Why `namesBuild`: `parseJenkinsBuildLocation` is deliberately permissive — it answers "could this
 * be a Jenkins build", which the details path then confirms with a request. A GitHub Actions check
 * URL (`…/actions/runs/123/job/456`) parses as a job named `456` with no build, so treating that as
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
 *
 * A Jenkins check that is *also* a GitHub check run belongs here, not to the Jenkins leg: the
 * Checks plugin starts a build when its check run is rerequested, and that path needs no Jenkins
 * credentials in Orca. Routing it to both halves is how one click started two builds.
 */
export function isGitHubRerunCandidate(check: PRCheckDetail): boolean {
  if (isJenkinsCheck(check)) {
    return typeof check.checkRunId === 'number'
  }
  return (
    typeof check.workflowRunId === 'number' ||
    typeof check.checkRunId === 'number' ||
    parseActionsRunId(check.url) !== undefined
  )
}

/**
 * Whether the Jenkins leg may start this build, which needs the link Jenkins actually POSTs at.
 *
 * Why not when there is a check run: rerequesting that check run and POSTing at the job would start
 * the same build twice, and the check run is the path that works without Jenkins credentials here.
 */
function isJenkinsRebuildTarget(check: PRCheckDetail): boolean {
  return isJenkinsCheck(check) && typeof check.checkRunId !== 'number'
}

/**
 * A mixed failure list, split by the provider that owns each check.
 *
 * Two exclusions that only apply to Jenkins:
 *
 * - A build that is still queued or running is never rerun: starting a second build of a job that
 *   is already building is not what anyone means by "rerun", and Jenkins would run them
 *   concurrently in one workspace.
 * - Two checks can name the same build (a legacy status and a check run from one Jenkins), so the
 *   list is deduplicated on the build URL — one build must not be started twice by one click.
 */
export function selectRerunTargets({
  checks,
  failedOnly
}: {
  checks: PRCheckDetail[]
  failedOnly: boolean
}): { jenkins: PRCheckDetail[]; github: PRCheckDetail[] } {
  const candidates = failedOnly ? checks.filter(isRerunnableFailure) : checks
  const seenBuildUrls = new Set<string>()
  const jenkins = candidates.filter((check) => {
    if (!isJenkinsRebuildTarget(check) || check.status !== 'completed') {
      return false
    }
    const buildUrl = parseJenkinsBuildLocation(check.url)?.buildUrl
    if (buildUrl === undefined || seenBuildUrls.has(buildUrl)) {
      return false
    }
    seenBuildUrls.add(buildUrl)
    return true
  })
  return { jenkins, github: candidates.filter(isGitHubRerunCandidate) }
}
