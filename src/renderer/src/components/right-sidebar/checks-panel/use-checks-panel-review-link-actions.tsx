import { useCallback, useLayoutEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { openGitHubPRLinkModal } from '../github-pr-link-modal'
import { getWorkspaceAttachments } from '../../../../../shared/workspace-attachments'
import { getWorkspaceAttachmentKey } from '../../../../../shared/workspace-attachment-normalization'
import { buildWorkspaceAttachmentEdits } from '../../sidebar/worktree-attachment-editing'
import { findWorkspaceReviewAttachment } from '../workspace-review-selection'
import type { ChecksPanelCheckAndReviewActionsInput } from './check-and-review-action-dependencies'
import { useUnlinkGitHubPullRequest } from './use-unlink-github-pull-request'

type RefreshLinkedGitHubPullRequest = (linkedPRNumber: number) => Promise<void>

export function useChecksPanelReviewLinkActions(
  model: ChecksPanelCheckAndReviewActionsInput,
  refreshLinkedGitHubPullRequest: RefreshLinkedGitHubPullRequest
) {
  const {
    activeReview,
    activeWorktree,
    activeWorktreeId,
    branch,
    fetchHostedReviewForBranch,
    linkedGitLabMR,
    linkedPR,
    localExecutionScope,
    openModal,
    repo,
    repoConnectionId,
    runtimeEnvironmentId,
    suppressedGitHubPR,
    updateWorktreeMeta
  } = model
  const reviewLinkScopeKey = JSON.stringify([
    repo?.id ?? null,
    repo?.path ?? null,
    activeWorktree?.id ?? null,
    activeWorktree?.path ?? null,
    branch,
    activeWorktree?.hostId ?? null,
    repo?.executionHostId ?? null,
    repoConnectionId,
    runtimeEnvironmentId,
    localExecutionScope
  ])
  const selectWorkspaceReview = useAppStore((s) => s.selectWorkspaceReview)
  const reviewLinkScopeKeyRef = useRef(reviewLinkScopeKey)
  const reviewLinkActionGenerationRef = useRef(0)
  useLayoutEffect(() => {
    reviewLinkScopeKeyRef.current = reviewLinkScopeKey
  }, [reviewLinkScopeKey])

  const unlinkGitHubPullRequest = useUnlinkGitHubPullRequest({
    activeReview,
    activeWorktree,
    activeWorktreeId,
    linkedPR,
    updateWorktreeMeta
  })

  const handleUnlinkReview = useCallback(() => {
    if (!activeWorktreeId || !activeWorktree || !activeReview) {
      return
    }
    reviewLinkActionGenerationRef.current += 1
    // Why the shown review's own row rather than the workspace's slot: with a switcher, clearing the
    // slot would unlink the review the user is not looking at and leave the one they are. It is also
    // the only path that removes a review the branch lookup discovered, because a slot-only clear
    // would let that lookup attach it again.
    const shownAttachment = findWorkspaceReviewAttachment(activeWorktree, activeReview)
    if (shownAttachment) {
      const initial = getWorkspaceAttachments(activeWorktree)
      const removedKey = getWorkspaceAttachmentKey(shownAttachment)
      const draft = initial.filter((entry) => getWorkspaceAttachmentKey(entry) !== removedKey)
      // Why the suppression: the same tombstone the sidebar's row unlink writes, so a GitHub review
      // the branch lookup still resolves does not come straight back.
      selectWorkspaceReview(activeWorktreeId, null)
      void (async () => {
        const result = await updateWorktreeMeta(
          activeWorktreeId,
          {
            ...buildWorkspaceAttachmentEdits({ initial, draft }),
            ...(shownAttachment.provider === 'github'
              ? { suppressedGitHubPR: shownAttachment.number }
              : {})
          },
          { executionHostId: activeWorktree.hostId }
        )
        if (!result.ok) {
          toast.error(result.error)
        }
      })()
      return
    }
    if (activeReview.provider === 'github') {
      void unlinkGitHubPullRequest()
      return
    }
    if (linkedGitLabMR === null) {
      return
    }
    void updateWorktreeMeta(
      activeWorktreeId,
      { linkedGitLabMR: null },
      { executionHostId: activeWorktree.hostId }
    )
  }, [
    activeReview,
    activeWorktree,
    activeWorktreeId,
    linkedGitLabMR,
    selectWorkspaceReview,
    unlinkGitHubPullRequest,
    updateWorktreeMeta
  ])

  const openLinkPullRequestModal = useCallback(
    (currentPR: number) => {
      if (!activeWorktreeId || !activeWorktree) {
        return
      }
      const openedScopeKey = reviewLinkScopeKey
      openGitHubPRLinkModal({
        openModal,
        worktree: activeWorktree,
        worktreeId: activeWorktreeId,
        currentPR,
        suppressHostedReviewRefresh: true,
        afterLinked: async (linkedPRNumber) => {
          const actionGeneration = reviewLinkActionGenerationRef.current + 1
          reviewLinkActionGenerationRef.current = actionGeneration
          if (
            reviewLinkScopeKeyRef.current !== openedScopeKey ||
            reviewLinkActionGenerationRef.current !== actionGeneration
          ) {
            return
          }
          await refreshLinkedGitHubPullRequest(linkedPRNumber)
        }
      })
    },
    [
      activeWorktree,
      activeWorktreeId,
      openModal,
      refreshLinkedGitHubPullRequest,
      reviewLinkScopeKey
    ]
  )

  const handleLinkAnotherReview = useCallback(() => {
    if (!activeWorktreeId || !activeWorktree || !activeReview || !repo || !branch) {
      return
    }
    if (activeReview.provider === 'github') {
      openLinkPullRequestModal(activeWorktree.linkedPR ?? activeReview.number)
      return
    }
    const openedScopeKey = reviewLinkScopeKey
    openModal('edit-meta', {
      worktreeId: activeWorktreeId,
      // Pin the dialog owner because workspace IDs can repeat across hosts.
      repoId: activeWorktree.repoId,
      executionHostId: activeWorktree.hostId,
      currentDisplayName: activeWorktree.displayName,
      currentIssue: activeWorktree.linkedIssue,
      reviewProvider: 'gitlab',
      currentReview: activeWorktree.linkedGitLabMR ?? activeReview.number,
      currentComment: activeWorktree.comment,
      focus: 'pr',
      suppressHostedReviewRefresh: true,
      afterSave: async ({
        updates
      }: {
        updates?: { linkedPR?: unknown; linkedGitLabMR?: unknown }
      }) => {
        const actionGeneration = reviewLinkActionGenerationRef.current + 1
        reviewLinkActionGenerationRef.current = actionGeneration
        const isActionCurrent = (): boolean =>
          reviewLinkScopeKeyRef.current === openedScopeKey &&
          reviewLinkActionGenerationRef.current === actionGeneration
        if (!isActionCurrent()) {
          return
        }
        const nextMR = updates?.linkedGitLabMR
        if (typeof nextMR !== 'number') {
          return
        }
        await fetchHostedReviewForBranch(repo.path, branch, {
          repoId: repo.id,
          repoOwnerExecutionHostId: activeWorktree.hostId,
          linkedGitHubPR: null,
          linkedGitLabMR: nextMR,
          linkedBitbucketPR: null,
          linkedAzureDevOpsPR: null,
          linkedGiteaPR: null
        })
      }
    })
  }, [
    activeReview,
    activeWorktree,
    activeWorktreeId,
    branch,
    fetchHostedReviewForBranch,
    openModal,
    openLinkPullRequestModal,
    repo,
    reviewLinkScopeKey
  ])

  const handleLinkSuppressedPullRequest = useCallback(() => {
    if (linkedPR !== null || typeof suppressedGitHubPR !== 'number') {
      return
    }
    openLinkPullRequestModal(suppressedGitHubPR)
  }, [linkedPR, openLinkPullRequestModal, suppressedGitHubPR])

  return { handleUnlinkReview, handleLinkAnotherReview, handleLinkSuppressedPullRequest }
}
