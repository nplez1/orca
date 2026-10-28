import { useCallback, useEffect, useRef } from 'react'
import { checksPanelAsyncResultKey } from '../checks-panel-async-result-key'
import { loadGitLabJobLogDetails } from '@/runtime/gitlab-job-trace-client'
import { checksPanelLoadErrorMessage } from './checks-panel-forge-owner'
import { forgeOwnerHostIdForWorkspace } from '@/runtime/forge-credential-target'
import { loadCheckDetailsWithProviderFallback } from '@/runtime/jenkins-check-details-client'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'

import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'

type ChecksPanelReviewDataInput = Pick<
  ChecksPanelContextState,
  'activeGitLabReview' | 'pr' | 'prCacheKey' | 'prNumber'
> &
  Pick<
    ChecksPanelControllerState,
    | 'branch'
    | 'fetchPRCheckDetails'
    | 'fetchPRComments'
    | 'gitLabProjectRefRef'
    | 'isPanelVisible'
    | 'repo'
    | 'activeWorktree'
    | 'setComments'
    | 'setCommentsError'
    | 'setCommentsLoading'
  > &
  Pick<ChecksPanelComposerState, 'isCurrentAsyncResult'>

export function useChecksPanelReviewData(model: ChecksPanelReviewDataInput) {
  const {
    activeGitLabReview,
    branch,
    fetchPRCheckDetails,
    fetchPRComments,
    gitLabProjectRefRef,
    isCurrentAsyncResult,
    isPanelVisible,
    pr,
    prCacheKey,
    prNumber,
    repo,
    activeWorktree,
    setComments,
    setCommentsError,
    setCommentsLoading
  } = model
  const fetchComments = useCallback(
    async ({
      force = false,
      prNumberOverride,
      prRepoOverride
    }: {
      force?: boolean
      prNumberOverride?: number | null
      prRepoOverride?: PRInfo['prRepo'] | null
    } = {}) => {
      const targetPRNumber = prNumberOverride ?? prNumber
      const targetPRRepo = prRepoOverride ?? pr?.prRepo
      if (!repo || !targetPRNumber) {
        return
      }
      setCommentsLoading(true)
      try {
        const requestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          targetPRNumber,
          targetPRRepo,
          pr?.headSha
        )
        const result = await fetchPRComments(repo.path, targetPRNumber, {
          force,
          repoId: repo.id,
          prRepo: targetPRRepo,
          headSha: pr?.headSha
        })
        if (!isCurrentAsyncResult(requestKey)) {
          return
        }
        setComments(result)
      } catch (err) {
        if (
          !isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, targetPRRepo, pr?.headSha)
          )
        ) {
          return
        }
        console.warn('Failed to fetch PR comments:', err)
        setComments([])
        setCommentsError(
          checksPanelLoadErrorMessage(err, forgeOwnerHostIdForWorkspace(repo, activeWorktree))
        )
      } finally {
        if (
          isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, targetPRRepo, pr?.headSha)
          )
        ) {
          setCommentsLoading(false)
        }
      }
    },
    [
      repo,
      prNumber,
      pr?.headSha,
      pr?.prRepo,
      prCacheKey,
      fetchPRComments,
      branch,
      isCurrentAsyncResult,
      setCommentsLoading,
      setComments,
      setCommentsError,
      activeWorktree
    ]
  )

  const handleLoadCheckDetails = useCallback(
    async (check: PRCheckDetail) => {
      if (!repo) {
        return null
      }
      if (check.gitlabJobId) {
        return loadGitLabJobLogDetails({
          repoPath: repo.path,
          repoId: repo.id,
          repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(repo, activeWorktree),
          check,
          projectRef: gitLabProjectRefRef.current
        })
      }
      return loadCheckDetailsWithProviderFallback(check, () =>
        fetchPRCheckDetails(
          repo.path,
          {
            checkRunId: check.checkRunId,
            workflowRunId: check.workflowRunId,
            checkName: check.name,
            url: check.url,
            prRepo: pr?.prRepo ?? null
          },
          { repoId: repo.id }
        )
      )
    },
    [fetchPRCheckDetails, pr?.prRepo, repo, activeWorktree, gitLabProjectRefRef]
  )

  // Read the ref at call time because async MR fetches can fill it after render.
  const getGitLabProjectRef = useCallback(() => gitLabProjectRefRef.current, [gitLabProjectRefRef])
  // Why: `fetchPRComments` serves a five-minute renderer cache, so re-reading the payload after the
  // PR's review state moved has to ask for fresh data — otherwise an approval that lands while the
  // panel is open never appears, which is the entire point of watching those fields.
  const reviewRevisionRef = useRef<{ prCacheKey: string; revision: string } | null>(null)

  useEffect(() => {
    if (activeGitLabReview) {
      return
    }
    if (!repo || !prNumber || !isPanelVisible) {
      setComments([])
      return
    }
    let cancelled = false
    const requestKey = checksPanelAsyncResultKey(
      prCacheKey,
      branch,
      prNumber,
      pr?.prRepo,
      pr?.headSha
    )
    const revision = `${pr?.reviewDecision ?? ''}|${pr?.updatedAt ?? ''}`
    const previousRevision = reviewRevisionRef.current
    // Why the prCacheKey check: switching PRs also changes the revision, and a first read of a PR has
    // no reason to bypass the cache.
    const reviewStateMoved =
      previousRevision !== null &&
      previousRevision.prCacheKey === prCacheKey &&
      previousRevision.revision !== revision
    reviewRevisionRef.current = { prCacheKey, revision }
    setCommentsLoading(true)
    void fetchPRComments(repo.path, prNumber, {
      force: reviewStateMoved,
      repoId: repo.id,
      prRepo: pr?.prRepo,
      headSha: pr?.headSha
    }).then(
      (result) => {
        if (!cancelled && isCurrentAsyncResult(requestKey)) {
          setComments(result)
          setCommentsLoading(false)
        }
      },
      () => {
        if (!cancelled && isCurrentAsyncResult(requestKey)) {
          setComments([])
          setCommentsLoading(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [
    activeGitLabReview,
    repo,
    prNumber,
    pr?.headSha,
    pr?.prRepo,
    // Why: the review verdicts ride on this payload, so a decision or activity change on the PR has
    // to re-read it — otherwise an approval landing while the panel is open never appears. GitHub
    // bumps `updated_at` on review submission, so this is the cheap "the PR changed" signal.
    pr?.reviewDecision,
    pr?.updatedAt,
    prCacheKey,
    branch,
    isPanelVisible,
    fetchPRComments,
    isCurrentAsyncResult,
    setComments,
    setCommentsLoading
  ])

  useEffect(() => {
    if (activeGitLabReview || !repo || !prNumber || !isPanelVisible) {
      return undefined
    }
    return window.api.gh.onWorkItemMutated((payload) => {
      const sameRepo =
        payload.repoId != null ? payload.repoId === repo.id : payload.repoPath === repo.path
      if (!sameRepo || payload.type !== 'pr' || payload.number !== prNumber) {
        return
      }
      void fetchComments({ force: true })
    })
  }, [activeGitLabReview, fetchComments, isPanelVisible, prNumber, repo])
  return { fetchComments, handleLoadCheckDetails, getGitLabProjectRef }
}

export type ChecksPanelReviewDataState = ReturnType<typeof useChecksPanelReviewData>
