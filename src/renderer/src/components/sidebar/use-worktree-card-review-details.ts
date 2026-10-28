import { useState } from 'react'
import { getDetachedWorkspaceReviewRequest } from './workspace-detached-review-request'
import { getLinearReadScope, scopedLinearCacheKey } from '@/store/slices/linear/linear-slice-scope'
import { getWorkspaceAttachmentSourceContext } from './workspace-attachment-source-result'
import { getWorkspaceReferenceLinearWorkspaceId } from './workspace-reference-details'
import { getWorktreeGitIdentityDisplay } from '../../../../shared/worktree/git-identity-display'
import { useAppStore } from '@/store'
import { findLinkedIssueRepo, linkedIssueRepoIsOffDevice } from '@/lib/linked-issue-repo'
import { getGitHubPRCacheKey } from '../../../../shared/github/github-cache-key'
import { issueCacheKey as getIssueCacheKey } from '@/store/github/cache-identity'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { areTaskSourceContextsEqual } from '../../../../shared/task-source-context'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getWorktreeCardPrDisplay,
  isCachedMergedBranchPRCurrentForWorktree
} from './worktree-card-pr-display'
import type { WorktreeCardProps } from './worktree-card-model'
import type { useWorktreeCardFoundation } from './use-worktree-card-foundation'

type Foundation = ReturnType<typeof useWorktreeCardFoundation>

export function useWorktreeCardReviewDetails({
  worktree,
  repo,
  settings,
  projectGroups,
  cardProps,
  newCardStyle
}: Pick<WorktreeCardProps, 'worktree' | 'repo'> &
  Pick<Foundation, 'settings' | 'projectGroups' | 'cardProps' | 'newCardStyle'>) {
  const gitIdentityDisplay = getWorktreeGitIdentityDisplay(worktree)
  const detachedHeadDisplay = gitIdentityDisplay?.kind === 'detached' ? gitIdentityDisplay : null
  const branch = gitIdentityDisplay?.kind === 'branch' ? gitIdentityDisplay.branchName : ''
  const workspaceScope = parseWorkspaceKey(worktree.id)
  const folderWorkspaceId =
    workspaceScope?.type === 'folder' ? workspaceScope.folderWorkspaceId : null
  const isFolder = repo ? isFolderRepo(repo) : folderWorkspaceId !== null
  // Why: project groups gate folder workspaces, so folder paths stay hidden from identity surfaces until that capability exists.
  const hasProjectGroups = projectGroups.length > 0
  const branchIdentityDisplay = !isFolder && branch.length > 0 ? branch : undefined
  const folderPathIdentityDisplay =
    isFolder && hasProjectGroups && worktree.path.trim().length > 0 ? worktree.path : undefined
  const identityDisplay = branchIdentityDisplay ?? folderPathIdentityDisplay
  const hasPathIdentityEnabled = cardProps.includes('branch')
  const showIdentityInNewCard = newCardStyle && hasPathIdentityEnabled && Boolean(identityDisplay)
  const folderMetaRowContent = newCardStyle
    ? hasPathIdentityEnabled && Boolean(folderPathIdentityDisplay)
    : isFolder
  const hostedReviewExactKey = getDetachedWorkspaceReviewRequest(worktree, repo)?.key
  // Why the link's repo rather than the workspace's: a workspace created from a task on
  // another host lives in that project's repo, while the issue stays where the task was
  // listed — the same disagreement that left the Issue pane unreadable. The pane, this key
  // and the refresh sweeps all resolve it through one helper so the card cannot show a state
  // the pane contradicts. `repo` stays the workspace row: the PR/checks surfaces below are
  // about this workspace's own git repo, not about its issue.
  const issueRepo = useAppStore((s) =>
    worktree.linkedIssue ? findLinkedIssueRepo(s.repos, worktree, worktree.linkedIssue) : null
  )
  // Why: with no row there is no cache key, so the entry stays `undefined` — which the
  // presentation reads as "still loading". The link cannot load here, so it must settle.
  const issueRepoIsOffDevice = useAppStore((s) =>
    worktree.linkedIssue
      ? linkedIssueRepoIsOffDevice(s.repos, worktree, worktree.linkedIssue)
      : false
  )
  const hostedReviewCacheKey =
    hostedReviewExactKey ??
    (repo && branch
      ? getHostedReviewCacheKey(
          repo.path,
          branch,
          settings,
          repo.id,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : '')
  const prCacheKey =
    repo && branch
      ? getGitHubPRCacheKey(
          repo.path,
          repo.id,
          branch,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const issueCacheKey =
    issueRepo && worktree.linkedIssue
      ? getIssueCacheKey(
          issueRepo.path,
          issueRepo.id,
          worktree.linkedIssue,
          settings,
          issueRepo.connectionId,
          issueRepo.executionHostId,
          true
        )
      : ''
  // Saved workspace bindings keep equal Linear identifiers separate.
  const nextLinearSourceContext = getWorkspaceAttachmentSourceContext('linear', repo, worktree)
  // Preserve equal source-context identity so metadata writes do not retrigger Linear fetches.
  const [linearSourceContext, setLinearSourceContext] = useState(nextLinearSourceContext)
  if (!areTaskSourceContextsEqual(linearSourceContext, nextLinearSourceContext)) {
    setLinearSourceContext(nextLinearSourceContext)
  }
  const linearWorkspaceId = getWorkspaceReferenceLinearWorkspaceId(
    worktree.linkedLinearIssueWorkspaceId,
    linearSourceContext
  )
  const linearIssueCacheKey = worktree.linkedLinearIssue
    ? scopedLinearCacheKey(
        getLinearReadScope(settings, linearSourceContext),
        `${linearWorkspaceId}::${worktree.linkedLinearIssue}`
      )
    : ''

  // Subscribe to ONLY the specific cache entry, not entire review/issue caches.
  const hostedReviewEntry = useAppStore((s) =>
    hostedReviewCacheKey ? s.hostedReviewCache[hostedReviewCacheKey] : undefined
  )
  const prCacheEntry = useAppStore((s) => (prCacheKey ? s.prCache?.[prCacheKey] : undefined))
  const issueEntry = useAppStore((s) => (issueCacheKey ? s.issueCache[issueCacheKey] : undefined))
  const linearIssueEntry = useAppStore((s) =>
    linearIssueCacheKey ? s.linearIssueCache[linearIssueCacheKey] : undefined
  )
  const linearIssueFallbackEntry = useAppStore((s) =>
    !linearSourceContext && worktree.linkedLinearIssue
      ? s.linearIssueCache[worktree.linkedLinearIssue]
      : undefined
  )

  const hostedReview: HostedReviewInfo | null | undefined =
    hostedReviewEntry !== undefined ? hostedReviewEntry.data : undefined
  const linkedGitHubPR = worktree.linkedPR ?? null
  const linkedGitLabMR = worktree.linkedGitLabMR ?? null
  const linkedBitbucketPR = worktree.linkedBitbucketPR ?? null
  const linkedAzureDevOpsPR = worktree.linkedAzureDevOpsPR ?? null
  const linkedGiteaPR = worktree.linkedGiteaPR ?? null
  const hasNonGitHubLinkedReview =
    linkedGitLabMR !== null ||
    linkedBitbucketPR !== null ||
    linkedAzureDevOpsPR !== null ||
    linkedGiteaPR !== null
  const hasLinkedReview =
    linkedGitHubPR !== null ||
    linkedGitLabMR !== null ||
    linkedBitbucketPR !== null ||
    linkedAzureDevOpsPR !== null ||
    linkedGiteaPR !== null
  // Why: a newer hosted-review miss trusts the merged-PR cache only when the stored head proves it still describes the current commit.
  const cachedBranchPR = prCacheEntry?.data
  const cachedBranchPRFetchedAt = prCacheEntry?.fetchedAt
  const cachedMergedBranchPRMatchesCurrentHead = isCachedMergedBranchPRCurrentForWorktree(
    cachedBranchPR,
    worktree
  )
  const cachedBranchFallbackGitHubPRNumber =
    linkedGitHubPR === null &&
    !hasNonGitHubLinkedReview &&
    cachedBranchPR?.number !== undefined &&
    (cachedBranchPR.state !== 'merged' || cachedMergedBranchPRMatchesCurrentHead)
      ? cachedBranchPR.number
      : null
  const cachedBranchPRCanDriveDisplay =
    cachedBranchPR?.state !== 'merged' || cachedMergedBranchPRMatchesCurrentHead
  const hostedReviewMatchesHeadMatchedCachedMergedPR =
    cachedMergedBranchPRMatchesCurrentHead &&
    cachedBranchPR !== null &&
    cachedBranchPR !== undefined &&
    hostedReview?.provider === 'github' &&
    hostedReview.number === cachedBranchPR.number
  const useCachedBranchReview =
    cachedBranchPR !== undefined &&
    cachedBranchPR !== null &&
    !hasNonGitHubLinkedReview &&
    cachedBranchPRCanDriveDisplay &&
    (hostedReview === undefined ||
      (cachedMergedBranchPRMatchesCurrentHead && !hostedReviewMatchesHeadMatchedCachedMergedPR) ||
      (hostedReview === null &&
        ((cachedBranchPRFetchedAt !== undefined &&
          cachedBranchPRFetchedAt > (hostedReviewEntry?.fetchedAt ?? 0)) ||
          cachedMergedBranchPRMatchesCurrentHead)))
  const cachedBranchReview = useCachedBranchReview
    ? hostedReviewInfoFromGitHubPRInfo(cachedBranchPR)
    : hostedReview
  // Why: branch provenance does not supersede the head-ownership gate for merged PRs.
  const branchLookupGitHubPRNumber =
    hostedReview?.provider === 'github' &&
    hostedReview.state === 'merged' &&
    !isCachedMergedBranchPRCurrentForWorktree(hostedReview, worktree)
      ? null
      : hostedReviewEntry?.branchLookupGitHubPRNumber
  const prDisplay = getWorktreeCardPrDisplay(
    cachedBranchReview,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    {
      reviewHintKey:
        (useCachedBranchReview || cachedMergedBranchPRMatchesCurrentHead) && !hasLinkedReview
          ? ''
          : hostedReviewEntry?.linkedReviewHintKey,
      branchLookupGitHubPRNumber,
      suppressedGitHubPR: worktree.suppressedGitHubPR ?? null
    }
  )

  return {
    detachedHeadDisplay,
    branch,
    folderWorkspaceId,
    isFolder,
    branchIdentityDisplay,
    folderPathIdentityDisplay,
    identityDisplay,
    showIdentityInNewCard,
    folderMetaRowContent,
    hostedReviewCacheKey,
    issueRepo,
    issueRepoIsOffDevice,
    issueCacheKey,
    issueEntry,
    linearIssueEntry,
    linearIssueFallbackEntry,
    linearSourceContext,
    linearWorkspaceId,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    cachedBranchFallbackGitHubPRNumber,
    prDisplay
  }
}
