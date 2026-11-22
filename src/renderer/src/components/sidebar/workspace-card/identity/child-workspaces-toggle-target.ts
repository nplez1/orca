import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { getWorktreeOnHostFromState } from '@/store/workspaces/selection/worktree-on-host-selector'
import type { AppState } from '@/store/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getHoveredWorkspaceIdentity } from './hovered-workspace-identity'
import { computeRenderedSidebarRows } from '../../worktree-list/listing/rendered-sidebar-worktree-order'
import { getPublishedLineageFoldKeys } from '../../worktree-list/listing/visible-worktrees'
import {
  indexLineageFoldKeys,
  mergeSameBranchRows,
  shouldMergeSameBranchCards
} from '../../worktree-list/grouping/same-branch-row-merge'
import { buildProjectGroupingIndex } from '../../../../../../shared/sidebar-list/sections/project-section-grouping'
import { getProjectHostSetupProjectionFromState } from '@/store/projects/project-host-setup-selector'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import { computeVisibleWorktrees } from '../../worktree-list/listing/compute-visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from '../../worktree-list/listing/visible-worktree-options-from-state'
import { getWorktreeLineageGroupKey } from '../../../../../../shared/sidebar-list/sections/group-keys'
import {
  getHostScopedWorktreeLineageInputs,
  getWorktreeLineageAncestors
} from '../../../../../../shared/sidebar-list/lineage/worktree-lineage-projection'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'

type ChildWorkspacesToggleState = Pick<
  AppState,
  'activeWorkspaceExecutionHostId' | 'activeWorktreeId' | 'worktreeLineageById' | 'worktreesByRepo'
>
type HoverDocument = NonNullable<Parameters<typeof getHoveredWorkspaceIdentity>[0]>

function resolveTargetWorktree(
  state: ChildWorkspacesToggleState,
  doc: HoverDocument
): Worktree | undefined {
  const hovered = getHoveredWorkspaceIdentity(doc)
  if (hovered) {
    return getIndexedAllWorktrees(selectWorktreesByRepo(state)).find(
      (worktree) =>
        worktree.id === hovered.workspaceId &&
        getWorktreeHostIdentity(worktree) === hovered.hostIdentity
    )
  }
  return state.activeWorktreeId
    ? getWorktreeOnHostFromState(
        state,
        state.activeWorktreeId,
        state.activeWorkspaceExecutionHostId ?? undefined
      )
    : undefined
}

function getParentWorktree(
  state: ChildWorkspacesToggleState,
  target: Worktree
): Worktree | undefined {
  // Only non-archived rows on the same host can be rendered lineage children.
  const worktrees = getIndexedAllWorktrees(selectWorktreesByRepo(state)).filter(
    (worktree) => worktree.hostId === target.hostId && !worktree.isArchived
  )
  const { worktreeMap, lineageById } = getHostScopedWorktreeLineageInputs(
    worktrees,
    state.worktreeLineageById,
    target.hostId
  )
  return getWorktreeLineageAncestors(target, lineageById, worktreeMap)[0]
}

export function resolveChildWorkspacesToggleGroupKeys(
  state: ChildWorkspacesToggleState,
  renderedChipKeys: ReadonlyMap<string, readonly string[]>,
  doc: HoverDocument = document
): readonly string[] | null {
  const target = resolveTargetWorktree(state, doc)
  if (!target || target.isArchived) {
    return null
  }
  const ownKeys = renderedChipKeys.get(getWorktreeLineageGroupKey(target))
  if (ownKeys) {
    return ownKeys
  }
  const parent = getParentWorktree(state, target)
  const parentKeys = parent ? renderedChipKeys.get(getWorktreeLineageGroupKey(parent)) : undefined
  return parentKeys ?? null
}

/** Which keys each rendered workspace's chip folds; mounted rows so temporary reveal
 * and drag policies match the chip the user sees. */
export function getRenderedLineageChipKeys(
  state: AppState
): ReadonlyMap<string, readonly string[]> {
  const published = getPublishedLineageFoldKeys()
  if (published !== null) {
    return published
  }
  const visibleWorktrees = computeVisibleWorktrees(
    selectWorktreesByRepo(state),
    [],
    buildVisibleWorktreeOptionsFromState(state, getIndexedRepoMap(state.repos))
  )
  const rows = computeRenderedSidebarRows(state, visibleWorktrees)
  if (!shouldMergeSameBranchCards(state)) {
    return indexLineageFoldKeys(rows)
  }
  const projection = getProjectHostSetupProjectionFromState(state)
  return indexLineageFoldKeys(
    // Why drop host headers: a merge groups siblings by depth, and a header is never one.
    mergeSameBranchRows(
      rows.filter((row): row is Row => row.type !== 'host-header'),
      getIndexedRepoMap(state.repos),
      buildProjectGroupingIndex({
        projects: projection.projects,
        projectHostSetups: projection.setups
      }),
      // Why the local constant: this map holds keys, and ordering only needs a
      // reference host. A workspace with no host of its own is local anyway.
      LOCAL_EXECUTION_HOST_ID,
      undefined,
      state.collapsedGroups
    )
  )
}
