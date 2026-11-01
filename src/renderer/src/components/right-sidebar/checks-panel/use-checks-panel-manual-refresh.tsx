/* eslint-disable max-lines -- Why: upstream's manual refresh plus the fork's carry-over of the
   refreshed PR's repo and head SHA into the acknowledgement path. */
import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { buildGitHubPRRefreshStateClearToken } from '@/store/github/pr-refresh-state'
import { refreshHostedReviewCard } from '@/store/slices/hosted-review-card-refresh'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import { getRuntimeGitUpstreamStatus } from '@/runtime/runtime-git-sync-client'
import { resolveWorktreeGitCopyNow } from '@/lib/worktree-git-copy'
import {
  hasChecksPanelGitStatusBranchChanged,
  readChecksPanelRefreshGitIdentitySnapshot,
  shouldCommitChecksPanelGitStatusSnapshot
} from '../checks-panel-git-status-snapshot'

import { checksPanelAsyncResultKey } from '../checks-panel-async-result-key'
import { recordChecksPanelPRRefreshBreadcrumb } from '../checks-panel-pr-refresh-breadcrumb'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { ChecksPanelManualRefreshInput } from './manual-refresh-dependencies'

// The manual Refresh is a user act: it may start a stopped WSL distro (E9).
const MANUAL_STATUS_READ = { admissionTier: 'interactive', wakeWslDistro: true } as const
export function useChecksPanelManualRefresh(model: ChecksPanelManualRefreshInput) {
  const {
    activeConnectionId,
    activeGitLabReview,
    activeWorktreeId,
    activeWorktreePath,
    activeWorktreePushTarget,
    asyncResultKeyRef,
    branch,
    expireGitHubPRRefreshState,
    fallbackGitHubPRNumber,
    fetchGitLabDetails,
    fetchHostedReviewForBranch,
    fetchPRChecks,
    fetchPRComments,
    fetchPRForBranch,
    gitStatusSnapshot,
    isCurrentAsyncResult,
    isFolder,
    isGitLabReviewContext,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    linkedPR,
    ownerCopyHostId,
    ownerTarget,
    panelContextKey,
    panelContextKeyRef,
    pollIntervalRef,
    pr,
    prCacheKey,
    prNumber,
    prevChecksRef,
    refreshInFlightRef,
    refreshRequestKeyRef,
    repo,
    reviewSelection,
    setChecks,
    setChecksLoading,
    setComments,
    setCommentsLoading,
    setEligibilityRefreshNonce,
    setGitStatusSnapshot,
    setIsRefreshing,
    showsPickedReview,
    updateWorktreeGitIdentity
  } = model
  // Why the pick rather than the selection's flag: the pane only renders a pick it can render, and
  // every branch below has to agree with what the header shows.
  const pickedReview = showsPickedReview ? reviewSelection.selectedReview : null
  const handleRefresh = useCallback(async () => {
    if (!repo || !branch) {
      return
    }
    if (refreshInFlightRef.current) {
      return
    }
    // Latch before render disables the button so double-clicks cannot duplicate Git subprocesses.
    refreshInFlightRef.current = true
    const initialRequestKey = checksPanelAsyncResultKey(
      prCacheKey,
      branch,
      prNumber,
      pr?.prRepo,
      pr?.headSha
    )
    const refreshRequestKey = `${activeWorktreeId ?? ''}::${prCacheKey}::${branch}::${Date.now()}::${Math.random()}`
    refreshRequestKeyRef.current = refreshRequestKey
    const isCurrentRequest = (): boolean => refreshRequestKeyRef.current === refreshRequestKey
    setIsRefreshing(true)
    // Why before the git-status probe: a picked review is not this branch's PR, so the branch path
    // below would refresh, and then re-read checks for, a review the user is not looking at.
    if (pickedReview) {
      try {
        const refreshedReview = await reviewSelection.refreshSelectedReview()
        if (!isCurrentRequest()) {
          return
        }
        // The review carries the head this refresh read, so checks key on the commit that was just
        // fetched rather than the one the closure captured before the refresh.
        const headSha = refreshedReview?.headSha ?? pickedReview.headSha
        if (refreshedReview?.provider === 'gitlab' || activeGitLabReview) {
          // Why the GitLab details path: an MR's rows come from the MR's pipelines and comments,
          // not from GitHub checks, and its number is not a GitHub PR number.
          await fetchGitLabDetails({
            mrNumberOverride: refreshedReview?.number ?? activeGitLabReview?.number ?? null,
            headShaOverride: headSha ?? null,
            commitAsCurrent: true
          })
          return
        }
        const pickedPRNumber = refreshedReview?.number ?? pickedReview.number
        // Why the refreshed key: the review may have moved its head, and the pane's current result
        // key then names the old one, which would discard the rows fetched here.
        asyncResultKeyRef.current = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          pickedPRNumber,
          pr?.prRepo,
          headSha
        )
        setChecksLoading(true)
        setCommentsLoading(true)
        const [refreshedChecks, refreshedComments] = await Promise.all([
          // Why no branch: it is what the store writes this PR's check status onto, and this
          // branch's cached PR is a different review.
          fetchPRChecks(repo.path, pickedPRNumber, undefined, headSha, pr?.prRepo, {
            force: true,
            repoId: repo.id,
            wakeWslDistro: true
          }),
          fetchPRComments(repo.path, pickedPRNumber, {
            force: true,
            repoId: repo.id,
            prRepo: pr?.prRepo,
            headSha
          })
        ])
        if (!isCurrentRequest() || !isCurrentAsyncResult(asyncResultKeyRef.current)) {
          return
        }
        setChecks(refreshedChecks)
        setComments(refreshedComments)
      } catch (error) {
        // Why swallowed: the shown rows stay, and the pane's own error surface already reports a
        // provider failure for the review it could read.
        console.warn('Failed to refresh the selected review:', error)
      } finally {
        if (isCurrentRequest()) {
          setChecksLoading(false)
          setCommentsLoading(false)
          refreshInFlightRef.current = false
          setIsRefreshing(false)
        }
      }
      return
    }
    const refreshStartedAt = Date.now()
    const refreshProvider = isGitLabReviewContext ? 'gitlab' : 'github'
    let refreshOutcome = 'started'
    recordChecksPanelPRRefreshBreadcrumb({
      event: 'start',
      provider: refreshProvider,
      repoId: repo.id,
      worktreeId: activeWorktreeId,
      branch,
      prCacheKey,
      prNumber: activeGitLabReview?.number ?? prNumber,
      prState: activeGitLabReview?.state ?? pr?.state,
      prChecksStatus: pr?.checksStatus,
      refreshState: prCacheKey ? useAppStore.getState().prRefreshStates[prCacheKey] : null
    })
    try {
      if (activeWorktreeId && activeWorktreePath && !isFolder && ownerTarget) {
        // Why one resolution: a same-path twin must not get this copy's transport, SSH target or answer.
        const copy = resolveWorktreeGitCopyNow(activeWorktreeId, ownerCopyHostId)
        const ownerHostId = copy?.hostId ?? null
        const snapshotIdentity = readChecksPanelRefreshGitIdentitySnapshot({
          snapshot: gitStatusSnapshot,
          contextKey: panelContextKey,
          currentBranch: branch
        })
        if (snapshotIdentity.kind === 'changed') {
          updateWorktreeGitIdentity(
            activeWorktreeId,
            { head: snapshotIdentity.head, branch: snapshotIdentity.branch },
            ownerHostId
          )
          // A discovered terminal branch switch must restart branch-keyed effects rather than refresh old PR data.
          refreshOutcome = 'branch-changed'
          return
        }
        try {
          const statusContext = {
            target: copy?.transport ?? ownerTarget,
            worktreeId: activeWorktreeId,
            worktreePath: activeWorktreePath,
            connectionId: copy ? copy.connectionId : (activeConnectionId ?? undefined)
          }
          const status = await getRuntimeGitStatus(statusContext, MANUAL_STATUS_READ)
          const observedBranch = status.branch ?? (status.head ? null : undefined)
          updateWorktreeGitIdentity(
            activeWorktreeId,
            { head: status.head, branch: observedBranch },
            ownerHostId
          )
          if (
            observedBranch !== undefined &&
            hasChecksPanelGitStatusBranchChanged({
              observedBranch,
              currentBranch: branch
            })
          ) {
            // A discovered terminal branch switch must restart branch-keyed effects rather than refresh old PR data.
            refreshOutcome = 'branch-changed'
            return
          }
          let freshRemoteStatus = status.upstreamStatus
          if (activeWorktreePushTarget) {
            freshRemoteStatus = await getRuntimeGitUpstreamStatus(
              statusContext,
              activeWorktreePushTarget
            )
          } else if (
            !freshRemoteStatus ||
            (freshRemoteStatus.ahead > 0 &&
              freshRemoteStatus.behind > 0 &&
              freshRemoteStatus.behindCommitsArePatchEquivalent === undefined)
          ) {
            freshRemoteStatus = await getRuntimeGitUpstreamStatus(statusContext)
          }
          if (
            isCurrentRequest() &&
            shouldCommitChecksPanelGitStatusSnapshot(panelContextKeyRef.current, panelContextKey)
          ) {
            // Reuse this click's status read to refresh Publish/Create eligibility.
            setGitStatusSnapshot({
              contextKey: panelContextKey,
              hasUncommittedChanges: status.entries.length > 0,
              remoteStatus: freshRemoteStatus,
              gitIdentity: {
                head: status.head,
                branch: observedBranch
              }
            })
          }
        } catch (error) {
          console.warn('[ChecksPanel] pre-refresh git identity refresh failed', error)
        }
      }
      if (isGitLabReviewContext) {
        const refreshedReview = await refreshHostedReviewCard(fetchHostedReviewForBranch, {
          repoPath: repo.path,
          repoId: repo.id,
          branch,
          admissionTier: 'interactive',
          linkedGitHubPR: linkedPR,
          fallbackGitHubPR: fallbackGitHubPRNumber,
          linkedGitLabMR,
          linkedBitbucketPR,
          linkedAzureDevOpsPR,
          linkedGiteaPR
        })
        if (!isCurrentRequest()) {
          return
        }
        const refreshedGitLabReview =
          refreshedReview?.provider === 'gitlab' ? refreshedReview : activeGitLabReview
        if (refreshedGitLabReview) {
          await fetchGitLabDetails({
            mrNumberOverride: refreshedGitLabReview.number,
            headShaOverride: refreshedGitLabReview.headSha,
            commitAsCurrent: true
          })
          refreshOutcome = 'review'
        } else {
          setChecks([])
          setComments([])
          refreshOutcome = 'no-review'
        }
        return
      }
      const refreshStoreState = useAppStore.getState()
      const rawPRRefreshState = refreshStoreState.prRefreshStates[prCacheKey]
      const startedPRRefreshToken = buildGitHubPRRefreshStateClearToken(
        rawPRRefreshState,
        refreshStoreState.prRefreshSequences,
        prCacheKey
      )
      let refreshedPR: PRInfo | null = null
      try {
        refreshedPR = await fetchPRForBranch(repo.path, branch, {
          force: true,
          repoId: repo.id,
          worktreeId: activeWorktreeId ?? undefined,
          linkedPRNumber: linkedPR,
          fallbackPRNumber: fallbackGitHubPRNumber,
          reason: 'manual'
        })
      } finally {
        if (startedPRRefreshToken) {
          expireGitHubPRRefreshState(prCacheKey, startedPRRefreshToken)
        }
      }
      if (!isCurrentRequest()) {
        return
      }
      await refreshHostedReviewCard(fetchHostedReviewForBranch, {
        repoPath: repo.path,
        repoId: repo.id,
        branch,
        admissionTier: 'interactive',
        linkedGitHubPR: linkedPR,
        fallbackGitHubPR: refreshedPR?.number ?? fallbackGitHubPRNumber,
        linkedGitLabMR,
        linkedBitbucketPR,
        linkedAzureDevOpsPR,
        linkedGiteaPR
      })
      if (!isCurrentRequest()) {
        return
      }
      if (refreshedPR) {
        refreshOutcome = 'pr'
        const prRequestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          refreshedPR.number,
          refreshedPR.prRepo,
          refreshedPR.headSha
        )
        if (!isCurrentAsyncResult(initialRequestKey) && !isCurrentRequest()) {
          return
        }
        // Forced refresh may discover the number before React repaints; mark these checks current now.
        asyncResultKeyRef.current = prRequestKey
        // Pass fresh headSha directly; the closure predates force-pushes and PR-number changes.
        const refreshedChecks = fetchPRChecks(
          repo.path,
          refreshedPR.number,
          branch,
          refreshedPR.headSha,
          refreshedPR.prRepo,
          { force: true, repoId: repo.id, wakeWslDistro: true }
        ).then(
          (result) => {
            if (!isCurrentRequest() || !isCurrentAsyncResult(prRequestKey)) {
              return
            }
            setChecks(result)
            const signature = JSON.stringify(
              result.map((c) => `${c.name}:${c.status}:${c.conclusion}`)
            )
            pollIntervalRef.current =
              signature === prevChecksRef.current
                ? Math.min(pollIntervalRef.current * 2, 120_000)
                : 30_000
            prevChecksRef.current = signature
          },
          (err) => {
            if (!isCurrentRequest() || !isCurrentAsyncResult(prRequestKey)) {
              return
            }
            console.warn('Failed to fetch PR checks:', err)
            setChecks([])
          }
        )
        setChecksLoading(true)
        setCommentsLoading(true)
        const refreshedComments = fetchPRComments(repo.path, refreshedPR.number, {
          force: true,
          repoId: repo.id,
          prRepo: refreshedPR.prRepo,
          headSha: refreshedPR.headSha
        }).then(
          (result) => {
            if (isCurrentRequest() && isCurrentAsyncResult(prRequestKey)) {
              setComments(result)
            }
          },
          (err) => {
            if (!isCurrentRequest() || !isCurrentAsyncResult(prRequestKey)) {
              return
            }
            console.warn('Failed to fetch PR comments:', err)
            setComments([])
          }
        )
        await Promise.all([
          refreshedChecks.finally(() => {
            if (isCurrentRequest() && isCurrentAsyncResult(prRequestKey)) {
              setChecksLoading(false)
            }
          }),
          refreshedComments.finally(() => {
            if (isCurrentRequest() && isCurrentAsyncResult(prRequestKey)) {
              setCommentsLoading(false)
            }
          })
        ])
      } else if (isCurrentRequest()) {
        setChecks([])
        setComments([])
        refreshOutcome = 'no-pr'
      }
    } catch (error) {
      refreshOutcome = 'error'
      throw error
    } finally {
      recordChecksPanelPRRefreshBreadcrumb({
        event: 'done',
        provider: refreshProvider,
        repoId: repo.id,
        worktreeId: activeWorktreeId,
        branch,
        prCacheKey,
        prNumber: activeGitLabReview?.number ?? prNumber,
        prState: activeGitLabReview?.state ?? pr?.state,
        prChecksStatus: pr?.checksStatus,
        refreshState: prCacheKey ? useAppStore.getState().prRefreshStates[prCacheKey] : null,
        outcome: refreshOutcome,
        durationMs: Date.now() - refreshStartedAt,
        currentRequest: isCurrentRequest()
      })
      if (isCurrentRequest()) {
        refreshInFlightRef.current = false
        setIsRefreshing(false)
        // Rerun eligibility to clear resolved authentication errors even when Git state is unchanged.
        setEligibilityRefreshNonce((value) => value + 1)
      }
    }
  }, [
    repo,
    branch,
    activeConnectionId,
    activeWorktreeId,
    activeWorktreePath,
    activeWorktreePushTarget,
    activeGitLabReview,
    prNumber,
    pr?.checksStatus,
    pr?.headSha,
    pr?.prRepo,
    pr?.state,
    prCacheKey,
    linkedPR,
    fallbackGitHubPRNumber,
    fetchGitLabDetails,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    isFolder,
    isGitLabReviewContext,
    gitStatusSnapshot,
    panelContextKey,
    fetchPRForBranch,
    fetchPRChecks,
    fetchPRComments,
    fetchHostedReviewForBranch,
    expireGitHubPRRefreshState,
    isCurrentAsyncResult,
    ownerCopyHostId,
    ownerTarget,
    updateWorktreeGitIdentity,
    panelContextKeyRef,
    asyncResultKeyRef,
    setCommentsLoading,
    setEligibilityRefreshNonce,
    prevChecksRef,
    setIsRefreshing,
    setChecksLoading,
    refreshRequestKeyRef,
    setChecks,
    setComments,
    setGitStatusSnapshot,
    pollIntervalRef,
    refreshInFlightRef,
    reviewSelection,
    pickedReview,
    fetchGitLabDetails
  ])
  return { handleRefresh }
}

export type ChecksPanelRefreshState = ReturnType<typeof useChecksPanelManualRefresh>
