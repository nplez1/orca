import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../../../../shared/execution-host'
import { buildProjectGroupingIndex } from '../../../../../../shared/project-section-grouping'
import type { ProjectGroupingModel } from '../../../../../../shared/project-section-grouping'
import type { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { mergeSameBranchRows } from '../grouping/branch-groups'
import type { Row, WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'

type MergedSidebarRowsArgs = {
  rowPlan: ReturnType<typeof planSidebarRows>
  rowCollapsedGroups: Set<string>
  groupBy: WorktreeGroupBy
  workspaceHostScope: AppState['workspaceHostScope']
  visibleWorkspaceHostIds: readonly ExecutionHostId[] | null
  repoMap: ReadonlyMap<string, Repo>
  projectGrouping: ProjectGroupingModel
  defaultHostId: ExecutionHostId
  hostLabelById: ReadonlyMap<string, string> | undefined
}

/** The sidebar's rows: the plan's render, with same-branch cards merged where that is sound. */
export function useMergedSidebarRows(args: MergedSidebarRowsArgs): Row[] {
  const {
    rowPlan,
    rowCollapsedGroups,
    groupBy,
    workspaceHostScope,
    visibleWorkspaceHostIds,
    repoMap,
    projectGrouping,
    defaultHostId,
    hostLabelById
  } = args
  const mergeSameBranchWorkspaces = useAppStore((s) => s.mergeSameBranchWorkspaces)
  return useMemo(() => {
    const built = rowPlan.render(rowCollapsedGroups)
    // Why: merging is only sound inside a project section. An explicit host filter
    // splits rows into host sections, where a cross-host card has no home.
    const shouldMergeSameBranch =
      groupBy === 'repo' &&
      mergeSameBranchWorkspaces &&
      workspaceHostScope === ALL_EXECUTION_HOSTS_SCOPE &&
      !visibleWorkspaceHostIds
    return shouldMergeSameBranch
      ? mergeSameBranchRows(
          built,
          repoMap,
          buildProjectGroupingIndex(projectGrouping),
          defaultHostId,
          hostLabelById
        )
      : built
  }, [
    rowPlan,
    rowCollapsedGroups,
    groupBy,
    mergeSameBranchWorkspaces,
    workspaceHostScope,
    visibleWorkspaceHostIds,
    repoMap,
    projectGrouping,
    defaultHostId,
    hostLabelById
  ])
}
