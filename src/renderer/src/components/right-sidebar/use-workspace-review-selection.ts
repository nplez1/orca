import { useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  findWorkspaceReviewSelection,
  hasMultipleWorkspaceReviews,
  resolveWorkspaceReviewSelection,
  type WorkspaceActiveReview,
  type WorkspaceReviewSelectionEntry
} from './workspace-review-selection'
import {
  getWorkspaceReferenceRequest,
  getWorkspaceReferenceRuntimeVersion,
  type WorkspaceReferenceRequest
} from '../sidebar/workspace-reference-details'
import { canReadWorkspaceReferenceReview } from '../sidebar/workspace-reference-review-source'

/** The linked-review hint that names this entry's review to the host lookup.
 *
 *  The host reads one review by number through the same branch entry point the sidebar card uses,
 *  so the entry's provider picks the hint field and the other four stay null. */
function linkedReviewHintsFor(entry: Pick<WorkspaceReviewSelectionEntry, 'provider' | 'number'>): {
  linkedGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
} {
  return {
    linkedGitHubPR: entry.provider === 'github' ? entry.number : null,
    linkedGitLabMR: entry.provider === 'gitlab' ? entry.number : null,
    linkedBitbucketPR: entry.provider === 'bitbucket' ? entry.number : null,
    linkedAzureDevOpsPR: entry.provider === 'azure-devops' ? entry.number : null,
    linkedGiteaPR: entry.provider === 'gitea' ? entry.number : null
  }
}

export type WorkspaceReviewSelection = {
  entries: readonly WorkspaceReviewSelectionEntry[]
  /** The entry both panes show: the stored pick, else the workspace's own review. */
  selected: WorkspaceReviewSelectionEntry | null
  /** True while the shown review is the workspace's own, so a pane keeps its branch path. */
  isWorkspaceReview: boolean
  /** True once the workspace holds more than one review, which is when the switcher appears. */
  hasMultiple: boolean
  /** The picked review as its own cache holds it, or null while the lookup is in flight. Always
   *  null for the workspace's own review — the pane already has that one. */
  selectedReview: HostedReviewInfo | null
  selectReview: (key: string) => void
  /** Re-read the picked review from the host. A no-op for the workspace's own review, whose refresh
   *  belongs to the pane's own branch path. */
  refreshSelectedReview: () => Promise<HostedReviewInfo | null>
}

/** One workspace's review list and the review currently picked from it.
 *
 *  Both the Checks pane and Source Control read this, so they cannot describe different reviews:
 *  the pick lives in the fork's session-only slice, keyed by worktree, and never touches the
 *  workspace's `linkedPR` slot — that slot resolves push targets, so moving it to another branch's
 *  review would retarget a push. */
export function useWorkspaceReviewSelection({
  activeReview,
  isVisible,
  repo,
  worktree
}: {
  /** The workspace's own review, which leads the list and is what an unpicked workspace shows. */
  activeReview: HostedReviewInfo | null
  /** Only a visible pane reads the host; a hidden one shows whatever the cache already holds. */
  isVisible: boolean
  repo: Repo | undefined
  worktree: Worktree | null | undefined
}): WorkspaceReviewSelection {
  const worktreeId = worktree?.id ?? null
  const storedKey = useAppStore((s) =>
    worktreeId ? s.workspaceReviewSelectionByWorktree[worktreeId] : undefined
  )
  const selectWorkspaceReview = useAppStore((s) => s.selectWorkspaceReview)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)

  const activeProvider = activeReview?.provider ?? null
  const activeNumber = activeReview?.number ?? null
  const activeTitle = activeReview?.title ?? ''
  const activeUrl = activeReview?.url ?? ''
  // Why the fields rather than the review object: the review is rebuilt on every cache write, and
  // the list only changes when its identity does.
  const entries = useMemo(() => {
    const active: WorkspaceActiveReview | null =
      activeProvider !== null && activeNumber !== null
        ? { provider: activeProvider, number: activeNumber, title: activeTitle, url: activeUrl }
        : null
    return resolveWorkspaceReviewSelection(worktree, active)
  }, [worktree, activeProvider, activeNumber, activeTitle, activeUrl])

  const selected = findWorkspaceReviewSelection(entries, storedKey)
  const isWorkspaceReview = selected !== null && selected.key === entries[0]?.key

  // Why the runtime revision: the request key folds in the provider runtime, so a reconnected
  // runtime reads a fresh entry instead of the one the previous connection wrote.
  const runtimeVersion = useMemo(
    () => (worktree ? getWorkspaceReferenceRuntimeVersion(worktree, repo) : ''),
    [worktree, repo]
  )
  const request = useMemo<WorkspaceReferenceRequest | null>(
    () =>
      selected?.attachment && worktree
        ? getWorkspaceReferenceRequest(selected.attachment, worktree, repo, runtimeVersion)
        : null,
    [selected?.attachment, worktree, repo, runtimeVersion]
  )
  const cacheEntry = useAppStore((s) => (request ? s.hostedReviewCache[request.key] : undefined))
  const canRead =
    request !== null && canReadWorkspaceReferenceReview(request, activeReview?.provider)
  // Why the workspace's own review is excluded: the pane's branch path already fetched it, and a
  // second exact-key read would spend the same host lookup twice. Why only a missing entry: a pick
  // is read when it is selected and again on an explicit Refresh, and the checks the user watches
  // poll per review number, so this read does not need a cadence of its own.
  const needsLookup = canRead && !isWorkspaceReview && !cacheEntry

  const lookUpSelectedReview = useCallback(
    (force: boolean): Promise<HostedReviewInfo | null> => {
      if (!repo || !worktree || !request || !selected || !canRead || isWorkspaceReview) {
        return Promise.resolve(null)
      }
      return fetchHostedReviewForBranch(repo.path, worktree.branch ?? '', {
        exactReviewKey: request.key,
        ...(force ? { force: true } : {}),
        repoId: repo.id,
        repoOwnerExecutionHostId: getRepoExecutionHostId(repo),
        admissionTier: 'interactive',
        ...linkedReviewHintsFor(selected)
      })
    },
    [canRead, fetchHostedReviewForBranch, isWorkspaceReview, repo, request, selected, worktree]
  )

  useEffect(() => {
    if (!isVisible || !needsLookup) {
      return
    }
    // Why ignored: a failed lookup leaves the previous entry on screen, and the next selection or
    // Refresh asks again. This read has no user-facing error surface of its own.
    void lookUpSelectedReview(false).catch(() => {})
  }, [isVisible, lookUpSelectedReview, needsLookup])

  // Why clear here: a stored key that stops naming a non-default review — the workspace's own review
  // became the pick, or the review was unlinked — would otherwise leave the key pointing at a review
  // the pane no longer treats as a pick, and readers of the raw key (the unlink path) would disagree
  // with the pane about which review is shown.
  useEffect(() => {
    if (worktreeId && storedKey !== undefined && isWorkspaceReview) {
      selectWorkspaceReview(worktreeId, null)
    }
  }, [isWorkspaceReview, selectWorkspaceReview, storedKey, worktreeId])

  const selectReview = useCallback(
    (key: string): void => {
      if (!worktreeId) {
        return
      }
      // Why the workspace's own review stores nothing: dropping the pick restores the default, so a
      // workspace whose active review changes does not keep a stale pick.
      selectWorkspaceReview(worktreeId, key === entries[0]?.key ? null : key)
    },
    [entries, selectWorkspaceReview, worktreeId]
  )

  const refreshSelectedReview = useCallback(
    () => lookUpSelectedReview(true),
    [lookUpSelectedReview]
  )

  return {
    entries,
    selected,
    isWorkspaceReview,
    hasMultiple: hasMultipleWorkspaceReviews(entries),
    selectedReview: isWorkspaceReview ? null : (cacheEntry?.data ?? null),
    selectReview,
    refreshSelectedReview
  }
}
