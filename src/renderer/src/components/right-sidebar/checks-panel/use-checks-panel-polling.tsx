import { useChecksDetailTimer } from './use-checks-detail-timer'
import { ChecksDetailPollingPolicy } from './checks-detail-polling-policy'
import { useCallback, useEffect, useRef, useState } from 'react'
import { gitLabPipelineJobsToPRChecks } from '../../../../../shared/gitlab-pipeline-checks'
import {
  checksPanelAsyncResultKey,
  checksPanelHostedReviewAsyncResultKey
} from '../checks-panel-async-result-key'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'
import { fetchGitLabMRDetailsForChecks, gitLabMRCommentsToPRComments } from './gitlab-review-client'
import { checksPanelLoadErrorMessage } from './checks-panel-forge-owner'
import { forgeOwnerHostIdForWorkspace } from '@/runtime/forge-credential-target'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { isWslDistroNotRunningRefusal } from '../../../../../shared/wsl-distro-not-running-refusal'

function hasUnfinishedChecks(checks: readonly PRCheckDetail[]): boolean {
  return checks.some((check) => check.status !== 'completed')
}

export type ChecksPanelPollingInput = Pick<
  ChecksPanelContextState,
  | 'activeGitLabReview'
  | 'hostedReviewCacheKey'
  | 'pr'
  | 'prCacheKey'
  | 'prNumber'
  | 'showsPickedReview'
> &
  Pick<
    ChecksPanelControllerState,
    | 'asyncResultKeyRef'
    | 'activeWorktree'
    | 'branch'
    | 'checks'
    | 'fetchPRChecks'
    | 'isPanelVisible'
    | 'pollIntervalRef'
    | 'prevChecksRef'
    | 'repo'
    | 'retractStalePRRefreshError'
    | 'setChecks'
    | 'setChecksError'
    | 'setChecksLoading'
    | 'setComments'
    | 'setCommentsError'
    | 'setCommentsLoading'
    | 'gitLabProjectRefRef'
  > &
  Pick<ChecksPanelComposerState, 'isCurrentAsyncResult'>

export function useChecksPanelPolling(model: ChecksPanelPollingInput) {
  const modelRef = useRef(model)
  const [policy] = useState(() => new ChecksDetailPollingPolicy())
  const policyRef = useRef(policy)
  useEffect(() => {
    modelRef.current = model
  })
  const { activeGitLabReview, pr, prNumber, prCacheKey, branch, repo, hostedReviewCacheKey } = model
  const requestIdentity = JSON.stringify([
    repo?.id,
    repo?.path,
    repo?.executionHostId,
    repo?.connectionId,
    model.activeWorktree?.hostId,
    branch,
    activeGitLabReview ? 'gitlab' : 'github',
    activeGitLabReview?.number ?? prNumber,
    activeGitLabReview?.headSha ?? pr?.headSha,
    pr?.prRepo?.owner,
    pr?.prRepo?.repo,
    pr?.prRepo?.host,
    activeGitLabReview ? hostedReviewCacheKey : prCacheKey
  ])
  const gitLabDetailsLoadingGenerationRef = useRef(0)
  const fetchChecks = useCallback(
    async ({
      force = false,
      background = false,
      prNumberOverride,
      wakeWslDistro = false
    }: {
      force?: boolean
      background?: boolean
      prNumberOverride?: number | null
      /** Opening the panel or tab: a user act that may start a stopped WSL distro. */
      wakeWslDistro?: boolean
    } = {}) => {
      const {
        repo,
        prNumber,
        branch,
        pr,
        prCacheKey,
        checks,
        fetchPRChecks,
        isCurrentAsyncResult,
        activeWorktree,
        setChecksLoading,
        setChecks,
        setChecksError,
        pollIntervalRef,
        prevChecksRef,
        retractStalePRRefreshError,
        showsPickedReview
      } = modelRef.current
      const readStartedAt = Date.now()
      const checksPending = hasUnfinishedChecks(checks)
      const targetPRNumber = prNumberOverride ?? prNumber
      if (!repo || !targetPRNumber) {
        return
      }
      // Why: a scheduled poll refreshes rows that are already on screen; flipping the panel's
      // loading state for it blanks counts and disables buttons on every tick.
      if (!background) {
        setChecksLoading(true)
      }
      try {
        const requestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          targetPRNumber,
          pr?.prRepo,
          pr?.headSha
        )
        const result = await fetchPRChecks(
          repo.path,
          targetPRNumber,
          showsPickedReview ? undefined : branch,
          pr?.headSha,
          pr?.prRepo,
          {
            // Why: a run can change state without a headSha bump; skip the renderer/gh cache so the panel shows live progress.
            force: force || checksPending,
            throwOnError: true,
            repoId: repo.id,
            ...(wakeWslDistro ? { wakeWslDistro: true } : {})
          }
        )
        if (!isCurrentAsyncResult(requestKey)) {
          return
        }
        setChecks(result)
        if (!showsPickedReview) {
          retractStalePRRefreshError(prCacheKey, readStartedAt)
        }

        // Unchanged details back off; a changed result restores the selected cadence.
        const signature = policyRef.current.accept(result)
        pollIntervalRef.current =
          signature === prevChecksRef.current
            ? Math.min(pollIntervalRef.current * 2, 120_000)
            : 60_000
        prevChecksRef.current = signature
      } catch (err) {
        if (
          !isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, pr?.prRepo, pr?.headSha)
          )
        ) {
          return
        }
        // A stopped WSL distro is refused, not failed: the shown checks stay, Refresh starts it.
        if (!isWslDistroNotRunningRefusal(err)) {
          console.warn('Failed to fetch PR checks:', err)
        }
        setChecksError(
          checksPanelLoadErrorMessage(err, forgeOwnerHostIdForWorkspace(repo, activeWorktree))
        )
        policyRef.current.fail()
        pollIntervalRef.current = Math.min(Math.max(60_000, pollIntervalRef.current * 2), 900_000)
      } finally {
        if (
          !background &&
          isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, pr?.prRepo, pr?.headSha)
          )
        ) {
          setChecksLoading(false)
        }
      }
    },
    []
  )

  const fetchGitLabDetails = useCallback(
    async ({
      mrNumberOverride,
      headShaOverride,
      commitAsCurrent = false,
      isRequestCurrent,
      background = false,
      suppressLoading = background
    }: {
      mrNumberOverride?: number | null
      headShaOverride?: string | null
      commitAsCurrent?: boolean
      isRequestCurrent?: () => boolean
      /** A poll or tab entry: refused rather than booting a stopped WSL distro. */
      background?: boolean
      /** Rows are already on screen, so a refresh must not flash the loading state. */
      suppressLoading?: boolean
    } = {}) => {
      const {
        activeGitLabReview,
        repo,
        branch,
        hostedReviewCacheKey,
        asyncResultKeyRef,
        activeWorktree,
        isCurrentAsyncResult,
        gitLabProjectRefRef,
        setChecks,
        setChecksError,
        setChecksLoading,
        setComments,
        setCommentsError,
        setCommentsLoading,
        pollIntervalRef,
        prevChecksRef
      } = modelRef.current
      const targetMRNumber = mrNumberOverride ?? activeGitLabReview?.number ?? null
      const targetHeadSha =
        headShaOverride === undefined ? (activeGitLabReview?.headSha ?? null) : headShaOverride
      if (!repo || !targetMRNumber) {
        return
      }
      const requestKey = checksPanelHostedReviewAsyncResultKey(
        hostedReviewCacheKey,
        branch,
        'gitlab',
        targetMRNumber,
        targetHeadSha
      )
      if (isRequestCurrent?.() === false) {
        return
      }
      if (commitAsCurrent) {
        asyncResultKeyRef.current = requestKey
      }
      // Why: a background poll must not invalidate the generation a foreground request is about to
      // clear, or the flags it set stay true with nobody left to unset them.
      const loadingGeneration = suppressLoading
        ? gitLabDetailsLoadingGenerationRef.current
        : gitLabDetailsLoadingGenerationRef.current + 1
      if (!suppressLoading) {
        gitLabDetailsLoadingGenerationRef.current = loadingGeneration
        setChecksLoading(true)
        setCommentsLoading(true)
      }
      try {
        const details = await fetchGitLabMRDetailsForChecks({
          repoPath: repo.path,
          repoId: repo.id,
          iid: targetMRNumber,
          repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(repo, activeWorktree),
          background
        })
        if (isRequestCurrent?.() === false || !isCurrentAsyncResult(requestKey)) {
          return
        }
        if (details === null) {
          throw new Error('GitLab MR details are unavailable')
        }
        gitLabProjectRefRef.current = details.item.projectRef ?? null
        const result = gitLabPipelineJobsToPRChecks(details?.pipelineJobs ?? [])
        setChecks(result)
        setComments(gitLabMRCommentsToPRComments(details?.comments))
        const signature = policyRef.current.accept(result)
        pollIntervalRef.current =
          signature === prevChecksRef.current
            ? Math.min(pollIntervalRef.current * 2, 120_000)
            : 60_000
        prevChecksRef.current = signature
      } catch (err) {
        if (isRequestCurrent?.() === false || !isCurrentAsyncResult(requestKey)) {
          return
        }
        if (!isWslDistroNotRunningRefusal(err)) {
          console.warn('Failed to fetch GitLab MR checks:', err)
        }
        // One MR details request contains both pipeline and discussion; report failure for both.
        const message = checksPanelLoadErrorMessage(
          err,
          forgeOwnerHostIdForWorkspace(repo, activeWorktree)
        )
        setChecksError(message)
        setCommentsError(message)
        policyRef.current.fail()
        pollIntervalRef.current = Math.min(Math.max(60_000, pollIntervalRef.current * 2), 900_000)
      } finally {
        if (
          !suppressLoading &&
          gitLabDetailsLoadingGenerationRef.current === loadingGeneration &&
          isCurrentAsyncResult(requestKey)
        ) {
          setChecksLoading(false)
          setCommentsLoading(false)
        }
      }
    },
    []
  )

  useChecksDetailTimer({
    model,
    modelRef,
    policyRef,
    requestIdentity,
    fetchChecks,
    fetchGitLabDetails
  })

  return { fetchChecks, fetchGitLabDetails }
}

export type ChecksPanelPollingState = ReturnType<typeof useChecksPanelPolling>
