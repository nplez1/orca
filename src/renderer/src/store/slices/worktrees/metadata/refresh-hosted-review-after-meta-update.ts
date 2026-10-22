import type { Repo } from '../../../../../../shared/repo-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'
import type { AppState } from '../../../types'
import type { WorktreeMetaUpdateOptions } from '../../worktree-helpers'
import { getWorkspaceReviewRefreshHints } from './workspace-attachment-review-selection'

/**
 * Refetch the branch's hosted review after a metadata update, against the post-update links, so a
 * cache entry from the link the update replaced cannot keep showing the removed review.
 */
export function refreshHostedReviewAfterMetaUpdate(args: {
  state: Pick<AppState, 'fetchHostedReviewForBranch'>
  options?: WorktreeMetaUpdateOptions
  reviewRepo: Repo | undefined
  reviewBranch: string | undefined
  review: { repoOwnerExecutionHostId?: string }
  targetEnriched: Parameters<typeof getWorkspaceReviewRefreshHints>[0]
  worktreeForUpdate: Worktree | DetectedWorktreeListResult['worktrees'][number] | undefined
}): void {
  const { reviewRepo, reviewBranch, worktreeForUpdate } = args
  if (
    args.options?.suppressHostedReviewRefresh ||
    !reviewRepo ||
    !reviewBranch ||
    typeof args.state.fetchHostedReviewForBranch !== 'function'
  ) {
    return
  }
  void args.state.fetchHostedReviewForBranch(reviewRepo.path, reviewBranch, {
    repoId: reviewRepo.id,
    repoOwnerExecutionHostId: args.review.repoOwnerExecutionHostId,
    ...getWorkspaceReviewRefreshHints(args.targetEnriched, worktreeForUpdate),
    force: true
  })
}
