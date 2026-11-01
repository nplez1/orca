import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { useNow } from '@/hooks/use-now'
import { isFolderRepo } from '../../../../../shared/repo-kind'
import { getGitHubPRCacheKey } from '../../../../../shared/github/github-cache-key'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import { isStaleMergedGitHubReviewForHead } from '@/store/slices/hosted-review-cache-state'
import { selectReviewCacheEntry } from '../review-cache-entry-selection'
import { selectWorkspaceReviewState, type ChecksPanelReview } from '../checks-panel-review'
import { gitHubPRInfoFromHostedReview } from '../hosted-review-to-pr-info'
import { useWorkspaceReviewSelection } from '../use-workspace-review-selection'
import { isChecksPaneReviewProvider, pickShownReview } from '../workspace-review-selection'
import { isGitLabChecksPanelReview } from './gitlab-review-client'
import { clearPendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import {
  buildGitHubPRRefreshStateClearToken,
  getGitHubPRRefreshStateExpiryAt
} from '@/store/github/pr-refresh-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import { recordChecksPanelPRRefreshBreadcrumb } from '../checks-panel-pr-refresh-breadcrumb'
import { isChecksPanelHardRefreshErrorType } from '../checks-panel-review-creation'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { PRRefreshErrorType } from '../../../../../shared/github/pull-request-refresh-types'

type ChecksPanelContextStateInput = Pick<
  ChecksPanelControllerState,
  | 'activeWorktree'
  | 'activeWorktreeId'
  | 'branch'
  | 'claimedCommentResolutionRef'
  | 'commentResolutionLaunchAcceptedRef'
  | 'conflictSummaryRefreshKeyRef'
  | 'createPrInFlightRef'
  | 'isPanelVisible'
  | 'panelContextKey'
  | 'panelContextKeyRef'
  | 'pendingCommentResolutionRef'
  | 'pollIntervalRef'
  | 'prevChecksRef'
  | 'refreshContextKeyRef'
  | 'refreshInFlightRef'
  | 'refreshRequestKeyRef'
  | 'repo'
  | 'settings'
  | 'setAgentComposerState'
  | 'setChecks'
  | 'setChecksLoading'
  | 'setCommentResolutionAckBusyNow'
  | 'setComments'
  | 'setCommentsLoading'
  | 'setConflictDetailsRefreshing'
  | 'setCreatePrError'
  | 'setEditingTitle'
  | 'setEmptyRefreshing'
  | 'setGitStatusProbeErrorContextKey'
  | 'setGitStatusRefreshNonce'
  | 'setGitStatusSnapshot'
  | 'setHardRefreshError'
  | 'setHostedReviewCreationSnapshot'
  | 'setIsCreatingPr'
  | 'setIsPublishingBranch'
  | 'setIsRefreshing'
  | 'setTitleDraft'
  | 'setTitleSaving'
  | 'titleInputFocusTimerRef'
  | 'gitStatusSnapshotRetryTimerRef'
>

export function useChecksPanelContextState(model: ChecksPanelContextStateInput) {
  const {
    activeWorktree,
    activeWorktreeId,
    branch,
    claimedCommentResolutionRef,
    commentResolutionLaunchAcceptedRef,
    conflictSummaryRefreshKeyRef,
    createPrInFlightRef,
    isPanelVisible,
    panelContextKey,
    panelContextKeyRef,
    pendingCommentResolutionRef,
    pollIntervalRef,
    prevChecksRef,
    refreshContextKeyRef,
    refreshInFlightRef,
    refreshRequestKeyRef,
    repo,
    settings,
    setAgentComposerState,
    setChecks,
    setChecksLoading,
    setCommentResolutionAckBusyNow,
    setComments,
    setCommentsLoading,
    setConflictDetailsRefreshing,
    setCreatePrError,
    setEditingTitle,
    setEmptyRefreshing,
    setGitStatusProbeErrorContextKey,
    setGitStatusRefreshNonce,
    setGitStatusSnapshot,
    setHardRefreshError,
    setHostedReviewCreationSnapshot,
    setIsCreatingPr,
    setIsPublishingBranch,
    setIsRefreshing,
    setTitleDraft,
    setTitleSaving,
    titleInputFocusTimerRef,
    gitStatusSnapshotRetryTimerRef
  } = model
  const clearTitleInputFocusTimer = useCallback((): void => {
    if (titleInputFocusTimerRef.current !== null) {
      clearTimeout(titleInputFocusTimerRef.current)
      titleInputFocusTimerRef.current = null
    }
  }, [titleInputFocusTimerRef])

  const setChecksPanelContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) {
        clearTitleInputFocusTimer()
      }
    },
    [clearTitleInputFocusTimer]
  )

  // Reset during render for the same paint; key-based remounting caused Windows IPC storms.
  const [prevPanelContextKey, setPrevPanelContextKey] = useState(panelContextKey)
  const [prRefreshStateNow, setPrRefreshStateNow] = useState(() => Date.now())
  // Eligibility expires on wall time; tick separately from PR timers while this mounted panel is open.
  const panelClockNow = useNow(30_000)
  if (panelContextKey !== prevPanelContextKey) {
    setPrevPanelContextKey(panelContextKey)
    setEditingTitle(false)
    setTitleDraft('')
    setTitleSaving(false)
    clearTitleInputFocusTimer()
    setChecks([])
    setChecksLoading(false)
    setComments([])
    setCommentsLoading(false)
    setIsRefreshing(false)
    setEmptyRefreshing(false)
    setConflictDetailsRefreshing(false)
    createPrInFlightRef.current = null
    setIsCreatingPr(false)
    setCreatePrError(null)
    setIsPublishingBranch(false)
    setAgentComposerState(null)
    // Accepted launches retain their snapshot; clear only unaccepted queues, with ref writes deferred to the context effect.
    if (!commentResolutionLaunchAcceptedRef.current) {
      setCommentResolutionAckBusyNow(false)
      clearPendingPRCommentAiAck()
    }
    setHostedReviewCreationSnapshot(null)
    setHardRefreshError(null)
    setGitStatusSnapshot(null)
    setGitStatusProbeErrorContextKey(null)
    setGitStatusRefreshNonce((value) => value + 1)
    pollIntervalRef.current = 30_000
    prevChecksRef.current = ''
    conflictSummaryRefreshKeyRef.current = null
    refreshInFlightRef.current = false
    refreshRequestKeyRef.current = null
    if (gitStatusSnapshotRetryTimerRef.current) {
      clearTimeout(gitStatusSnapshotRetryTimerRef.current)
      gitStatusSnapshotRetryTimerRef.current = null
    }
  }

  const isFolder = repo ? isFolderRepo(repo) : false
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
  const hostedReviewCacheKey =
    repo && branch
      ? getHostedReviewCacheKey(
          repo.path,
          branch,
          settings,
          repo.id,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const refreshContextKey = `${activeWorktreeId ?? ''}::${prCacheKey}::${branch}`
  if (refreshContextKey !== refreshContextKeyRef.current) {
    refreshContextKeyRef.current = refreshContextKey
    refreshRequestKeyRef.current = null
  }
  // Background refresh replaces the whole cache map; subscribe only to this repo/branch entry.
  const prCacheEntry = useAppStore((s) => selectReviewCacheEntry(s.prCache, prCacheKey || null))
  // Why named for the branch: this is the review the workspace's own branch resolves to, which is
  // only the shown one until the user picks another from the switcher.
  const branchPR: PRInfo | null = isStaleMergedGitHubReviewForHead(
    prCacheEntry,
    activeWorktree?.head
  )
    ? null
    : (prCacheEntry?.data ?? null)
  const prCachedHasPR = prCacheEntry ? branchPR !== null : null
  const hostedReviewEntry = useAppStore((s) =>
    hostedReviewCacheKey ? s.hostedReviewCache[hostedReviewCacheKey] : undefined
  )
  const hostedReview = hostedReviewEntry?.data ?? null
  const linkedReviewNumber =
    activeWorktree?.linkedPR ??
    activeWorktree?.linkedGitLabMR ??
    activeWorktree?.linkedBitbucketPR ??
    activeWorktree?.linkedAzureDevOpsPR ??
    activeWorktree?.linkedGiteaPR ??
    null
  // Branch lookup loses fork/deleted-head PRs; prefer known review numbers from metadata/cache.
  const linkedPR = activeWorktree?.linkedPR ?? null
  const suppressedGitHubPR = activeWorktree?.suppressedGitHubPR ?? null
  const fallbackGitHubPRNumber = linkedPR == null ? (branchPR?.number ?? null) : null
  const linkedGitLabMR = activeWorktree?.linkedGitLabMR ?? null
  const linkedBitbucketPR = activeWorktree?.linkedBitbucketPR ?? null
  const linkedAzureDevOpsPR = activeWorktree?.linkedAzureDevOpsPR ?? null
  const linkedGiteaPR = activeWorktree?.linkedGiteaPR ?? null
  const workspaceReview: ChecksPanelReview | null = selectWorkspaceReviewState({
    prEntry: prCacheEntry,
    hostedEntry: hostedReviewEntry,
    currentHeadOid: activeWorktree?.head,
    linkedPR,
    suppressedGitHubPR,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR
  })
  const reviewSelection = useWorkspaceReviewSelection({
    activeReview: workspaceReview,
    isVisible: isPanelVisible,
    repo: repo ?? undefined,
    worktree: activeWorktree
  })
  // Why only GitHub and GitLab: those are the providers this pane can render checks and comments
  // for, so a picked review from another provider leaves the workspace's own review on screen
  // rather than blanking a pane that has nothing to show for it.
  const pickedReview = pickShownReview(reviewSelection, isChecksPaneReviewProvider)
  const activeReview: ChecksPanelReview | null = pickedReview ?? workspaceReview
  // Why derived from the review rather than left to the branch cache: a picked review is not this
  // branch's PR, so `prCache` has nothing for it. The mapping is a faithful rename of the same
  // fields, which keeps checks, comments and the head-sha freshness gate keyed on the shown PR.
  const pr: PRInfo | null = pickedReview ? gitHubPRInfoFromHostedReview(pickedReview) : branchPR
  const activeGitLabReview = isGitLabChecksPanelReview(activeReview) ? activeReview : null
  // Why gated on the workspace's own review: a picked GitHub review must not read as a GitLab
  // context just because this workspace also holds a GitLab MR.
  const isGitLabReviewContext = Boolean(
    activeGitLabReview || (reviewSelection.isWorkspaceReview && linkedGitLabMR !== null)
  )
  const activeConflictReview = activeReview?.mergeable === 'CONFLICTING' ? activeReview : null
  const prRefreshState = useAppStore((s) =>
    prCacheKey
      ? s.getEffectiveGitHubPRRefreshState(prCacheKey, Math.max(prRefreshStateNow, panelClockNow))
      : undefined
  )
  const rawPRRefreshState = useAppStore((s) =>
    prCacheKey ? s.prRefreshStates[prCacheKey] : undefined
  )
  const prNumber = pr?.number ?? null
  // Why the provider and number rather than the review object: the review is rebuilt on every cache
  // write, and only a switch to a different review should drop the rows below.
  const shownReviewKey = pickedReview ? `${pickedReview.provider}:${pickedReview.number}` : ''
  useEffect(() => {
    // Why: rows on screen belong to the review that was showing when they were fetched, so keeping
    // them while the new read is in flight would put another review's checks under this header.
    setChecks([])
    setComments([])
  }, [shownReviewKey, setChecks, setComments])

  useEffect(() => {
    const expiryAt = getGitHubPRRefreshStateExpiryAt(rawPRRefreshState)
    if (!prCacheKey || expiryAt === null) {
      return
    }
    const timeout = window.setTimeout(
      () => {
        setPrRefreshStateNow(Date.now())
        const storeState = useAppStore.getState()
        const rawState = storeState.prRefreshStates[prCacheKey]
        const token = buildGitHubPRRefreshStateClearToken(
          rawState,
          storeState.prRefreshSequences,
          prCacheKey
        )
        if (!token) {
          return
        }
        // Time alone emits no Zustand updates; clear abandoned refresh UI without asserting PR absence.
        recordChecksPanelPRRefreshBreadcrumb({
          event: 'stale_cleared',
          provider: 'github',
          repoId: repo?.id,
          worktreeId: activeWorktreeId,
          branch,
          prCacheKey,
          prNumber,
          prState: pr?.state,
          prChecksStatus: pr?.checksStatus,
          refreshState: rawState
        })
        storeState.expireGitHubPRRefreshState(prCacheKey, token)
      },
      Math.max(0, expiryAt - Date.now() + 1)
    )
    return () => window.clearTimeout(timeout)
  }, [
    activeWorktreeId,
    branch,
    pr?.checksStatus,
    pr?.state,
    prCacheKey,
    prNumber,
    rawPRRefreshState,
    repo?.id
  ])

  // Clear unaccepted payload refs in the effect to keep render pure.
  useEffect(() => {
    if (commentResolutionLaunchAcceptedRef.current) {
      return
    }
    pendingCommentResolutionRef.current = null
    claimedCommentResolutionRef.current = null
  }, [
    panelContextKey,
    claimedCommentResolutionRef,
    commentResolutionLaunchAcceptedRef,
    pendingCommentResolutionRef
  ])

  // Keep hard errors sticky across retries so Create stays blocked until qualifying eligibility clears them.
  useEffect(() => {
    const errorType = prRefreshState?.status === 'error' ? prRefreshState.errorType : undefined
    if (!isChecksPanelHardRefreshErrorType(errorType)) {
      return
    }
    const observedAt = prRefreshState?.updatedAt ?? Date.now()
    const contextKey = panelContextKeyRef.current
    setHardRefreshError((prev) => {
      if (prev && prev.contextKey === contextKey && prev.observedAt >= observedAt) {
        return prev
      }
      return { observedAt, errorType: errorType as PRRefreshErrorType, contextKey }
    })
  }, [prRefreshState, setHardRefreshError, panelContextKeyRef])
  return {
    clearTitleInputFocusTimer,
    setChecksPanelContentRef,
    prevPanelContextKey,
    prRefreshStateNow: Math.max(prRefreshStateNow, panelClockNow),
    isFolder,
    prCacheKey,
    hostedReviewCacheKey,
    refreshContextKey,
    prCacheEntry,
    pr,
    prCachedHasPR,
    hostedReview,
    linkedReviewNumber,
    linkedPR,
    suppressedGitHubPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    activeReview,
    activeGitLabReview,
    isGitLabReviewContext,
    activeConflictReview,
    prRefreshState,
    rawPRRefreshState,
    prNumber,
    reviewSelection
  }
}

export type ChecksPanelContextState = ReturnType<typeof useChecksPanelContextState>
