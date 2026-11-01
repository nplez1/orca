import { useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { openGitHubPRLinkModal } from '../github-pr-link-modal'
import { getWorkspaceAttachments } from '../../../../../shared/workspace-attachments'
import { getWorkspaceAttachmentKey } from '../../../../../shared/workspace-attachment-normalization'
import { buildWorkspaceAttachmentEdits } from '../../sidebar/worktree-attachment-editing'
import { findPickedReviewAttachment } from '../workspace-review-selection'
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
  // Why the stored key rather than a resolved list: unlinking is the only action here that has to
  // know whether the shown review is the workspace's own, and the key alone answers it — a key that
  // names the shown review means the switcher picked it, and a missing or stale key means it did
  // not. Reading it here keeps this hook off the panes' selection plumbing.
  const storedReviewKey = useAppStore((s) =>
    activeWorktreeId ? s.workspaceReviewSelectionByWorktree[activeWorktreeId] : undefined
  )
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
    // Why the shown review rather than the workspace's slot: once the switcher can show a second
    // review, unlinking through the slot would remove the one the user is not looking at and leave
    // the one they are.
    const pickedAttachment = findPickedReviewAttachment(
      activeWorktree,
      activeReview,
      storedReviewKey
    )
    if (pickedAttachment) {
      const initial = getWorkspaceAttachments(activeWorktree)
      const removedKey = getWorkspaceAttachmentKey(pickedAttachment)
      const draft = initial.filter((entry) => getWorkspaceAttachmentKey(entry) !== removedKey)
      // Why no suppression: a picked review is one the branch lookup did not return, so nothing
      // will re-attach it and suppressing its number would only mask a later real link.
      selectWorkspaceReview(activeWorktreeId, null)
      void updateWorktreeMeta(activeWorktreeId, buildWorkspaceAttachmentEdits({ initial, draft }), {
        executionHostId: activeWorktree.hostId
      })
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
    storedReviewKey,
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
