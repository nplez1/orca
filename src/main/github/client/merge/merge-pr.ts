import type { PRConflictSummary } from '../../../../shared/github/pull-request-types'
import { isGitHubPRAdminBypassAvailable } from '../../../../shared/github/pull-request-admin-bypass'
import { mapPRState } from '../../mappers'
import { getPRConflictSummary } from '../../conflict-summary'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { mergeGitHubPRStack } from '../../github-pr-stack'
import { githubPRStackExecutionScope, type GhExecOptions } from './../github-exec-scope'
import { detectRepositoryMergeMetadata } from './../detect/repository-merge-metadata'
import type { PullRequestLookupData } from './../lookup/pull-request-lookup-data'
import { derivePullRequestMergeable } from './../lookup/pull-request-lookup-data'
import { getRestPRByNumber, getPRByNumber } from './../lookup/pr-number-lookup'
import { STACK_METADATA_UNAVAILABLE_ERROR } from './../lookup/pr-stack-summary-cache'
/**
 * Merge a PR by number using gh CLI.
 * method: 'merge' | 'squash' | 'rebase' (default: 'squash')
 */
export async function mergePR(
  repoPath: string,
  prNumber: number,
  method: 'merge' | 'squash' | 'rebase' = 'squash',
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {},
  options: { bypassBranchProtection?: boolean } = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }
  await acquire()
  let concurrencySlotHeld = true
  try {
    let restData: PullRequestLookupData
    try {
      restData = await getRestPRByNumber(ownerRepo, prNumber, ghOptions, {
        requireUsableStackMetadata: true
      })
    } catch (err) {
      const diagnostic =
        err instanceof SyntaxError
          ? 'invalid JSON response'
          : err instanceof Error
            ? err.message
            : String(err)
      console.warn(
        `mergePR stack metadata probe failed for ${ownerRepo.owner}/${ownerRepo.repo}#${String(prNumber)}:`,
        diagnostic
      )
      return { ok: false, error: STACK_METADATA_UNAVAILABLE_ERROR }
    }
    if (restData.stack) {
      const mergeMetadata = await detectRepositoryMergeMetadata(
        ownerRepo,
        restData.stack.baseRefName,
        ghOptions,
        githubPRStackExecutionScope(connectionId, localGitOptions)
      )
      release()
      concurrencySlotHeld = false
      return await mergeGitHubPRStack({
        repository: ownerRepo,
        prNumber,
        method,
        mergeAction: mergeMetadata.mergeQueueRequired === true ? 'merge_queue' : 'direct_merge',
        headSha: restData.headRefOid,
        ghOptions
      })
    }
    const preflight = await getPRMergePreflight(
      repoPath,
      prNumber,
      ownerRepo,
      ghOptions,
      connectionId,
      localGitOptions,
      options
    )
    if (preflight.error) {
      return { ok: false, error: preflight.error }
    }

    // Don't use --delete-branch: it deletes the local branch, which fails while the worktree is checked out on it.
    const args = ['pr', 'merge', String(prNumber), `--${method}`]
    if (ownerRepo) {
      args.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
    }
    if (preflight.adminBypass) {
      // Why: `gh pr merge` refuses a BLOCKED pull request before the server ever sees it, so an
      // explicitly confirmed bypass has to reach GitHub through --admin. It is also what skips a
      // merge queue, which is why the preflight refuses a bypass on a queue-required base.
      args.push('--admin')
    }
    await ghExecFileAsync(args, {
      ...ghOptions,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: message }
  } finally {
    if (concurrencySlotHeld) {
      release()
    }
  }
}

export type PRMergePreflight = {
  /** Why the merge cannot proceed, or null when nothing stands in the way. */
  error: string | null
  /** True only when an unmet review gate was waived by a bypass GitHub confirmed for this viewer. */
  adminBypass: boolean
}

/**
 * What stands between this pull request and a merge.
 *
 * `reviewDecision` alone cannot answer that: it reports that a review is required, not whether the
 * requirement gates the person asking. A repository ruleset's bypass list, or an administrator
 * waiving classic branch protection, makes the two different — GitHub reports the pull request's
 * merge box as open for them, and `viewerCanMergeAsAdmin` says so in as many words. So a bypass is
 * honoured only when the caller asked for one *and* GitHub answered that this viewer may have it.
 */
export async function getPRMergePreflight(
  repoPath: string,
  prNumber: number,
  ownerRepo: GitHubApiRepository | null,
  ghOptions: GhExecOptions,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  options: { bypassBranchProtection?: boolean } = {}
): Promise<PRMergePreflight> {
  const unblocked: PRMergePreflight = { error: null, adminBypass: false }
  if (!ownerRepo) {
    return unblocked
  }

  try {
    const pr = await getPRByNumber(
      ownerRepo,
      prNumber,
      ghOptions,
      githubPRStackExecutionScope(connectionId, localGitOptions)
    )
    if (!pr) {
      return unblocked
    }
    // Why: the shared rule is the same one the presenters used to offer this merge, so the server
    // cannot be talked into a bypass the UI would not have shown. `mergeQueueRequired === false`
    // fails closed on an unknown queue, and an `--admin` merge would skip that queue.
    const bypassesReviewGate =
      options.bypassBranchProtection === true &&
      isGitHubPRAdminBypassAvailable({
        state: mapPRState(pr.state, pr.isDraft),
        mergeable: derivePullRequestMergeable(pr),
        mergeStateStatus: pr.mergeStateStatus,
        reviewDecision: pr.reviewDecision,
        viewerCanMergeAsAdmin: pr.viewerCanMergeAsAdmin,
        mergeQueueRequired: pr.mergeQueueRequired
      })
    if (!bypassesReviewGate) {
      if (pr.reviewDecision === 'REVIEW_REQUIRED') {
        return {
          error: 'This pull request requires review approval before it can be merged.',
          adminBypass: false
        }
      }
      if (pr.reviewDecision === 'CHANGES_REQUESTED') {
        return {
          error: 'This pull request has requested changes and cannot be merged yet.',
          adminBypass: false
        }
      }
    }
    if (pr.mergeQueueRequired === true) {
      return {
        error:
          'This pull request must be merged through GitHub merge queue. Use Merge when ready instead.',
        adminBypass: false
      }
    }
    // Why: conflict summaries shell out to local git; skip for SSH repos until that helper routes through the SSH provider.
    if (
      connectionId ||
      pr.mergeable !== 'CONFLICTING' ||
      !pr.baseRefName ||
      !pr.baseRefOid ||
      !pr.headRefOid
    ) {
      return { error: null, adminBypass: bypassesReviewGate }
    }

    const summary = await getPRConflictSummary(
      repoPath,
      pr.baseRefName,
      pr.baseRefOid,
      pr.headRefOid,
      localGitOptions
    )
    return {
      error: formatMergeConflictBlocker(pr.baseRefName, summary),
      adminBypass: bypassesReviewGate
    }
  } catch {
    // Why: conflict preflight should improve stale UI diagnostics, not block merge on a transient lookup failure.
    return unblocked
  }
}

export function formatMergeConflictBlocker(
  baseRefName: string,
  summary: PRConflictSummary | undefined
): string {
  const heading = 'This pull request has merge conflicts and cannot be merged yet.'
  if (!summary || summary.files.length === 0) {
    return `${heading}\nUpdate the branch with ${baseRefName} and resolve the conflicts before merging.`
  }

  const files = summary.files.map((file) => `- ${file}`).join('\n')
  const behind = `${summary.commitsBehind} commit${summary.commitsBehind === 1 ? '' : 's'} behind ${baseRefName}`
  return `${heading}\n${behind} (base commit: ${summary.baseCommit}).\n\nConflicting files:\n${files}`
}
