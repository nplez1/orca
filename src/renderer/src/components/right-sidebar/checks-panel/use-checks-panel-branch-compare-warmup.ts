import { useEffect } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitBranchCompare } from '@/runtime/runtime-git-diff-client'
import { useAppStore } from '@/store'
import { getWorktreeGitOwnerTarget } from '../worktree-git-owner-target'
import { resolveSourceControlBaseRef } from '../source-control/sync/base-ref-resolution'

/**
 * Keeps the worktree's branch compare warm while the Checks pane is showing.
 *
 * The compare — merge base to head, which is the review's own diff — is what lets a Checks-pane
 * comment open the hunks it was written against, but it is refreshed only by the Source Control
 * tab, which the Checks tab replaces. Without this, a jump from a comment on committed code lands
 * in a surface with no hunks because nothing in this session ever asked for the diff.
 */
export function useChecksPanelBranchCompareWarmup({
  activeReview,
  activeWorktree,
  activeWorktreeId,
  activeWorktreePath,
  isFolder,
  isPanelVisible,
  repo
}: {
  activeReview: { baseRefName?: string } | null
  activeWorktree: { baseRef?: string; head: string } | null
  activeWorktreeId: string | null
  activeWorktreePath: string | null
  isFolder: boolean
  isPanelVisible: boolean
  repo: { worktreeBaseRef?: string } | null
}): void {
  const hasActiveReview = activeReview !== null
  const baseRef = resolveSourceControlBaseRef({
    worktreeBaseRef: activeWorktree?.baseRef,
    reviewBaseRefName: activeReview?.baseRefName,
    repoBaseRef: repo?.worktreeBaseRef,
    // Why no default-base probe: a worktree with neither a pin nor a review base has no review to
    // compare against, and the jump falls back on the surfaces the checkout already proves.
    defaultBaseRef: null
  })
  const headOid = activeWorktree?.head ?? null

  useEffect(() => {
    if (
      !isPanelVisible ||
      isFolder ||
      !hasActiveReview ||
      !baseRef ||
      !activeWorktreeId ||
      !activeWorktreePath
    ) {
      return
    }
    const state = useAppStore.getState()
    const existing = state.gitBranchCompareSummaryByWorktree[activeWorktreeId]
    // Why: reuse a compare that already answers for this base and head instead of re-diffing the tree.
    if (
      existing?.status === 'ready' &&
      existing.baseRef === baseRef &&
      (headOid === null || existing.headOid === headOid)
    ) {
      return
    }
    const ownerTarget = getWorktreeGitOwnerTarget(activeWorktreeId)
    if (!ownerTarget) {
      return
    }
    const requestKey = `${activeWorktreeId}:${baseRef}:${headOid ?? ''}:${Date.now()}`
    state.beginGitBranchCompareRequest(activeWorktreeId, requestKey, baseRef, {
      preserveExistingSummary: true
    })
    let cancelled = false
    void getRuntimeGitBranchCompare(
      {
        target: ownerTarget,
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        connectionId: getConnectionId(activeWorktreeId) ?? undefined
      },
      baseRef,
      'background'
    )
      .then((result) => {
        if (!cancelled) {
          useAppStore.getState().setGitBranchCompareResult(activeWorktreeId, requestKey, result)
        }
      })
      // Why: a warm compare is advisory; a failed one leaves the jump on its existing fallbacks.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [
    activeWorktreeId,
    activeWorktreePath,
    baseRef,
    hasActiveReview,
    headOid,
    isFolder,
    isPanelVisible
  ])
}
