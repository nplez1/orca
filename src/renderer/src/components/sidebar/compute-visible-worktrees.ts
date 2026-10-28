import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../shared/execution-host'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { selectVisibleSidebarWorktrees } from '../../../../shared/sidebar-list/visible-worktrees'
import { buildDesktopWorkspaceRowFactReader } from './desktop-workspace-row-facts'
import { sidebarWorkspaceRowFilters } from './sidebar-filter-actions'
import { applyWorkspaceKindFilters } from './visible-worktree-kind-filters'
import { getLineageAncestorIndex, getSortedWorktreeRankIndex } from './visible-worktree-indexes'

// Separate store binding avoids attention-slice import cycles; shared builders retain the filter rules.

export type VisibleWorktreeOptions = {
  filterRepoIds: readonly string[]
  showSleepingWorkspaces: boolean
  tabsByWorktree: Record<string, Pick<TerminalTab, 'id'>[]> | null
  ptyIdsByTabId: Record<string, string[]> | null
  browserTabsByWorktree?: Record<string, { id: string }[]> | null
  worktreeIdsWithLiveAgent: ReadonlySet<string>
  worktreeIdsWithStructuredChat?: ReadonlySet<string>
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hiddenWorkspaceStatusIds?: readonly string[]
  hideWorkspacesFromOtherDevices: boolean
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
  alwaysShowDefaultBranchWorkspace?: boolean
  repoMap: Map<string, Repo>
  workspaceHostScope: ExecutionHostScope
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  defaultHostId: ExecutionHostId
  worktreeLineageById: Record<string, WorktreeLineage>
  injectLineageAncestors?: boolean
  preserveLineageParentOrder?: boolean
  forcedVisibleWorktreeIds?: readonly string[]
  /** The sorted keys are host identities (the stamp sort's), not bare ids, so a same-id pair keeps two ranks. */
  sortedByHostIdentity?: boolean
  /** Exempt from the sleeping sweep only; unlike forcedVisibleWorktreeIds, every other filter still applies. */
  sleepingSweepExemptWorktreeIds?: ReadonlySet<string>
}

export function computeVisibleWorktrees(
  worktreesByRepo: Record<string, Worktree[]>,
  sortedKeys: readonly string[],
  opts: VisibleWorktreeOptions
): Worktree[] {
  // The fork's workspace-status filter has no shared WorkspaceRowFilters key, so
  // it applies to the rows before the shared pipeline. The kind switches stay in
  // filterWorkspaceRows (which also exempts folder workspaces); re-applying them
  // here would hide folder roots, so only the status half is re-expressed.
  const rows = applyWorkspaceKindFilters(getIndexedAllWorktrees(worktreesByRepo), {
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hiddenWorkspaceStatusIds: opts.hiddenWorkspaceStatusIds ?? [],
    repoMap: opts.repoMap
  })

  const rankByKey = getSortedWorktreeRankIndex(sortedKeys)
  const keyOf = opts.sortedByHostIdentity
    ? getWorktreeHostIdentity
    : (worktree: Worktree) => worktree.id
  return selectVisibleSidebarWorktrees({
    rows,
    ancestorByIdentity: getLineageAncestorIndex(worktreesByRepo),
    rankOf: (worktree) => rankByKey.get(keyOf(worktree)),
    filters: sidebarWorkspaceRowFilters(opts),
    facts: buildDesktopWorkspaceRowFactReader(opts),
    worktreeLineageById: opts.worktreeLineageById,
    filterRepoIds: opts.filterRepoIds,
    injectLineageAncestors: opts.injectLineageAncestors,
    preserveLineageParentOrder: opts.preserveLineageParentOrder,
    forcedVisibleWorktreeIds: opts.forcedVisibleWorktreeIds
  })
}

export function computeVisibleWorktreeIds(
  worktreesByRepo: Record<string, Worktree[]>,
  sortedKeys: readonly string[],
  opts: VisibleWorktreeOptions
): string[] {
  return computeVisibleWorktrees(worktreesByRepo, sortedKeys, opts).map((worktree) => worktree.id)
}
