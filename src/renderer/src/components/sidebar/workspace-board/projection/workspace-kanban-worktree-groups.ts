import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../../../shared/worktree/types'
import type { SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import '../../workspace-status/presentation/workspace-status'
import { getWorkspaceStatus } from '../../../../../../shared/workspace-statuses'
import { compareWorktreeDisplayName } from '@/lib/worktree-display-name-order'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

function sortBoardWorktrees(a: Worktree, b: Worktree): number {
  return b.lastActivityAt - a.lastActivityAt || compareWorktreeDisplayName(a, b)
}

function sortManualBoardWorktrees(a: Worktree, b: Worktree): number {
  return (
    (b.manualOrder ?? b.sortOrder) - (a.manualOrder ?? a.sortOrder) ||
    compareWorktreeDisplayName(a, b)
  )
}

function groupBoardWorktreesByStatus(params: {
  worktrees: readonly Worktree[]
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  include: (worktree: Worktree) => boolean
}): Map<WorkspaceStatus, Worktree[]> {
  const grouped = new Map<WorkspaceStatus, Worktree[]>(
    params.workspaceStatuses.map((status) => [status.id, []])
  )
  for (const worktree of params.worktrees) {
    if (!params.include(worktree)) {
      continue
    }
    grouped.get(getWorkspaceStatus(worktree, params.workspaceStatuses))!.push(worktree)
  }
  return grouped
}

export function groupWorkspaceKanbanWorktrees(params: {
  worktrees: readonly Worktree[]
  visibleWorktreeIds: ReadonlySet<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  sortBy: SortBy
}): Map<WorkspaceStatus, Worktree[]> {
  const { worktrees, visibleWorktreeIds, workspaceStatuses, sortBy } = params
  const grouped = groupBoardWorktreesByStatus({
    worktrees,
    workspaceStatuses,
    include: (worktree) => visibleWorktreeIds.has(getWorktreeHostIdentity(worktree))
  })

  for (const items of grouped.values()) {
    items.sort(
      sortBy === 'manual'
        ? sortManualBoardWorktrees
        : (a, b) => Number(b.isPinned) - Number(a.isPinned) || sortBoardWorktrees(a, b)
    )
  }
  return grouped
}

/**
 * Lane members the sidebar filters are hiding, so a lane can say "hidden by filters" rather than
 * "Empty". Archived rows are excluded: no filter can ever show them.
 */
export function groupHiddenWorkspaceKanbanWorktrees(params: {
  worktrees: readonly Worktree[]
  visibleWorktreeIds: ReadonlySet<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): Map<WorkspaceStatus, Worktree[]> {
  return groupBoardWorktreesByStatus({
    worktrees: params.worktrees,
    workspaceStatuses: params.workspaceStatuses,
    include: (worktree) =>
      !worktree.isArchived && !params.visibleWorktreeIds.has(getWorktreeHostIdentity(worktree))
  })
}
