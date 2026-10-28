import { useEffect, useRef } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitBranchCompare } from '@/runtime/runtime-git-diff-client'
import { useAppStore } from '@/store'
import { getWorktreeGitOwnerTarget } from '../worktree-git-owner-target'
import {
  resolveSourceControlBaseRef,
  resolveSourceControlCompareBaseRef
} from '../../../../../shared/source-control-base-ref-resolution'

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
  remoteStatus,
  repo,
  settings
}: {
  activeReview: { baseRefName?: string } | null
  activeWorktree: { baseRef?: string; head: string } | null
  activeWorktreeId: string | null
  activeWorktreePath: string | null
  isFolder: boolean
  isPanelVisible: boolean
  remoteStatus: { upstreamName?: string } | null | undefined
  repo: { worktreeBaseRef?: string } | null
  settings: { sourceControlCompareAgainstUpstream?: boolean } | null
}): void {
  const hasActiveReview = activeReview !== null
  const worktreeBaseRef = activeWorktree?.baseRef
  const repoBaseRef = repo?.worktreeBaseRef
  // Why the same two steps as the Source Control tab: both writers share one compare slot, so a
  // different base here would have each tab replacing the other's result on every switch.
  const baseRef = resolveSourceControlCompareBaseRef({
    enabled: settings?.sourceControlCompareAgainstUpstream ?? false,
    worktreeBaseRef,
    repoBaseRef,
    upstreamName: remoteStatus?.upstreamName ?? null,
    fallbackBaseRef: resolveSourceControlBaseRef({
      worktreeBaseRef,
      reviewBaseRefName: activeReview?.baseRefName,
      repoBaseRef,
      // Why no default-base probe: a worktree with neither a pin nor a review base has no review to
      // compare against, and the jump falls back on the surfaces the checkout already proves.
      defaultBaseRef: null
    })
  })
  const headOid = activeWorktree?.head ?? null
  // Why: a compare that answered is not re-asked, and neither is one that already failed for this
  // exact base and head — hiding and reshowing the panel must not re-diff the tree.
  const lastAskedRef = useRef<string | null>(null)

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
    const askKey = `${activeWorktreeId}:${baseRef}:${headOid ?? ''}`
    if (lastAskedRef.current === askKey) {
      return
    }
    const state = useAppStore.getState()
    const existing = state.gitBranchCompareSummaryByWorktree[activeWorktreeId]
    if (
      existing?.status === 'ready' &&
      existing.baseRef === baseRef &&
      (headOid === null || existing.headOid === headOid)
    ) {
      lastAskedRef.current = askKey
      return
    }
    const ownerTarget = getWorktreeGitOwnerTarget(activeWorktreeId)
    if (!ownerTarget) {
      return
    }
    const requestKey = `${askKey}:${Date.now()}`
    state.beginGitBranchCompareRequest(activeWorktreeId, requestKey, baseRef, {
      preserveExistingSummary: true
    })
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
      // Why still claim it: the result is keyed to this request, so applying it after the panel
      // hides is safe — and dropping it would strand the compare for the tab that needs it.
      .then((result) => {
        lastAskedRef.current = askKey
        useAppStore.getState().setGitBranchCompareResult(activeWorktreeId, requestKey, result)
      })
      // Why: a warm compare is advisory, and a failed ask must not memoize — a reconnecting host
      // would otherwise never be asked again for this base and head.
      .catch(() => {})
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
