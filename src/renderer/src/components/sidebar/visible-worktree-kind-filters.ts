import type { Worktree } from '../../../../shared/worktree/types'
import { isDefaultBranchWorkspace } from './default-branch-workspace'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace
} from './visible-worktree-kinds'

type WorkspaceKindFilterOptions = {
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hiddenWorkspaceStatusIds: readonly string[]
}

/**
 * Applies the "what kind of workspace is this" filters in one place.
 *
 * Why extracted from visible-worktrees: that module sits at the line cap, and
 * the sidebar list, the board and the jump palette all apply the same set.
 */
export function applyWorkspaceKindFilters(
  worktrees: Worktree[],
  options: WorkspaceKindFilterOptions
): Worktree[] {
  let filtered = worktrees
  if (options.hideDefaultBranchWorkspace) {
    filtered = filtered.filter((worktree) => !isDefaultBranchWorkspace(worktree))
  }
  if (options.hideAutomationGeneratedWorkspaces) {
    filtered = filtered.filter((worktree) => !isAutomationGeneratedWorkspace(worktree))
  }
  if (options.hideCliCreatedWorkspaces) {
    filtered = filtered.filter((worktree) => !isCliCreatedWorkspace(worktree))
  }
  if (options.hideDetachedHeadWorkspaces) {
    filtered = filtered.filter((worktree) => !isDetachedHeadWorkspace(worktree))
  }
  if (options.hiddenWorkspaceStatusIds.length > 0) {
    const hiddenStatusIds = new Set(options.hiddenWorkspaceStatusIds)
    // Why the workspaceStatus guard: an unassigned workspace has nothing to match, so hiding by status must leave it visible.
    filtered = filtered.filter(
      (worktree) => !(worktree.workspaceStatus && hiddenStatusIds.has(worktree.workspaceStatus))
    )
  }
  return filtered
}
