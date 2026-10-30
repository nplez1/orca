import type { GitHubRerunPRChecksResult } from '../../../../shared/github/check-types'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
// Keep real error parsing available when tests mock gh-utils.
import { extractExecError } from '../../../git/exec-error'
import { classifyRerunChecksError } from '../../gh-error-classification'
import { isJenkinsCheck } from '../../../../shared/jenkins-rebuild'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { getPRChecks } from './get-pr-checks'
import { parseActionsRunId } from './check-detail-field-mapping'
import { codeHostFailure, classifiedFailure } from '../../../../shared/code-host-failure-copy'
export async function rerunPRChecks(
  repoPath: string,
  prNumber: number,
  options: {
    headSha?: string
    failedOnly?: boolean
    prRepo?: GitHubApiRepository | null
  } = {},
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubRerunPRChecksResult> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    options.prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return codeHostFailure('github.repoUnresolved')
  }

  const checks = await getPRChecks(
    repoPath,
    prNumber,
    options.headSha,
    ownerRepo,
    { noCache: true },
    connectionId,
    localGitOptions
  )
  // Why the Jenkins filter: a Jenkins link with no check run contributes nothing to either set — it
  // has no Actions run id and no check run to rerequest — so this only keeps it out of the loop that
  // builds those ids. A Jenkins link that *does* carry a check run stays: rerequesting it is the
  // GitHub path for that build, and the renderer keeps the Jenkins half off the same build (see
  // `selectRerunTargets`), which is what makes "exactly one path per build" true.
  const candidates = (
    options.failedOnly
      ? checks.filter((check) =>
          ['failure', 'cancelled', 'timed_out'].includes(check.conclusion ?? '')
        )
      : checks
  ).filter((check) => !isJenkinsCheck(check) || typeof check.checkRunId === 'number')
  const workflowRunIds = new Set(
    candidates
      .map((check) => check.workflowRunId ?? parseActionsRunId(check.url))
      .filter((id): id is number => typeof id === 'number')
  )
  const checkRunIds = new Set(
    candidates
      .filter((check) => !check.workflowRunId && !parseActionsRunId(check.url))
      .map((check) => check.checkRunId)
      .filter((id): id is number => typeof id === 'number')
  )

  if (workflowRunIds.size === 0 && checkRunIds.size === 0) {
    return codeHostFailure(
      options.failedOnly ? 'github.noFailedChecks' : 'github.noRerunnableChecks'
    )
  }

  let count = 0
  await acquire()
  try {
    for (const runId of workflowRunIds) {
      const endpoint = options.failedOnly
        ? `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/runs/${runId}/rerun-failed-jobs`
        : `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/runs/${runId}/rerun`
      await ghExecFileAsync(['api', '-X', 'POST', endpoint], {
        ...ghOptions,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' }
      })
      count += 1
    }
    for (const checkRunId of checkRunIds) {
      await ghExecFileAsync(
        [
          'api',
          '-X',
          'POST',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/check-runs/${checkRunId}/rerequest`
        ],
        { ...ghOptions, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }
      )
      count += 1
    }
    return { ok: true, count }
  } catch (err) {
    const { stderr } = extractExecError(err)
    const classified = classifyRerunChecksError(stderr)
    // Rerun POSTs are not idempotent; report partial success before the user retries.
    return count > 0
      ? {
          ok: false,
          error: `${classified.message} (${count} rerun${count === 1 ? '' : 's'} already started)`
        }
      : classifiedFailure(classified)
  } finally {
    release()
  }
}
