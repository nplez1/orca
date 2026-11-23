import type { AppState } from '@/store/types'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { getHostSectionCollapseKey } from '../../../../../../shared/sidebar-list/hosts/host-section-collapse'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getWorktreeLineageGroupKey } from '../../../../../../shared/sidebar-list/sections/group-keys'
import type { ProjectGroupingModel } from '../../../../../../shared/sidebar-list/sections/project-section-grouping'
import type { WorktreeOccurrencePlan } from '../../../../../../shared/sidebar-list/lineage/worktree-occurrence-plan'
import type {
  PinnedWorktreeDisplayPolicy,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { buildProjectGroupingIndex } from '../../../../../../shared/sidebar-list/sections/project-section-grouping'
import { buildHostOrderedMembers, getBranchGroupKeyForWorktree } from '../grouping/branch-groups'
import type { SidebarLineageParentIdentities } from '../../../../../../shared/sidebar-list/lineage/worktree-lineage-projection'
import { createSidebarPRGroupReader } from '../grouping/pr-group-key'

/**
 * The lineage groups each ancestor card folds, root first. Mirrors the merge's
 * grouping level by level: a card's members are the same-branch rows among the
 * previous level's members' children, so a nested card unfolds with its parent.
 */
function foldKeysByAncestor(args: {
  plan: WorktreeOccurrencePlan<Worktree>
  ancestors: readonly Worktree[]
  repoMap: Map<string, Repo>
  projectIndex: ReturnType<typeof buildProjectGroupingIndex>
  defaultHostId: ExecutionHostId
}): string[][] {
  const childrenByParent = new Map<string, Worktree[]>()
  let candidates: Worktree[] = []
  for (const candidate of args.plan.preferredByIdentity.values()) {
    if (candidate.placement === 'pinned') {
      continue
    }
    const parentKey = candidate.parent?.key
    if (parentKey === undefined) {
      candidates.push(candidate.row)
      continue
    }
    const siblings = childrenByParent.get(parentKey)
    if (siblings) {
      siblings.push(candidate.row)
    } else {
      childrenByParent.set(parentKey, [candidate.row])
    }
  }
  const keysByLevel: string[][] = []
  for (const ancestor of args.ancestors) {
    const branchKey = getBranchGroupKeyForWorktree(ancestor, args.repoMap, args.projectIndex)
    const sameBranch = candidates
      .filter(
        (candidate) =>
          branchKey !== null &&
          getBranchGroupKeyForWorktree(candidate, args.repoMap, args.projectIndex) === branchKey
      )
      .map((worktree) => ({ worktree, repo: args.repoMap.get(worktree.repoId) }))
    const members = buildHostOrderedMembers(sameBranch, args.repoMap, args.defaultHostId, undefined)
    const memberWorktrees = members?.map((member) => member.worktree) ?? []
    // Why: a pinned ancestor is never one of the merge's candidates, and its own key
    // still hides the target — so it stands alone at its level rather than vanishing.
    const ancestorIdentity = getWorktreeHostIdentity(ancestor)
    const levelWorktrees = memberWorktrees.some(
      (worktree) => getWorktreeHostIdentity(worktree) === ancestorIdentity
    )
      ? memberWorktrees
      : [ancestor]
    keysByLevel.push(levelWorktrees.map((worktree) => getWorktreeLineageGroupKey(worktree)))
    candidates = levelWorktrees.flatMap((worktree) => {
      const member = args.plan.preferredByIdentity.get(getWorktreeHostIdentity(worktree))
      return member ? (childrenByParent.get(member.key) ?? []) : []
    })
  }
  return keysByLevel
}

export function getWorktreeRevealCollapsedGroupKeys(args: {
  occurrencePlan?: WorktreeOccurrencePlan<Worktree>
  worktree: Worktree
  worktrees: readonly Worktree[]
  visibleWorktrees?: readonly Worktree[]
  filterRepoIds?: readonly string[]
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  /** Needed only without an occurrence plan, so a parent on another machine is revealed too. */
  lineageParentIdentities?: SidebarLineageParentIdentities
  repoMap: Map<string, Repo>
  defaultHostId: ExecutionHostId
  hostScopedGroups: boolean
  collapsedGroups: ReadonlySet<string>
  groupBy: WorktreeGroupBy
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  prCache: AppState['prCache'] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectGroups: readonly ProjectGroup[]
  projectGrouping?: ProjectGroupingModel
  /** Whether same-branch rows merged; when they did, a card folds several groups as one. */
  mergeSameBranchCards?: boolean
}): string[] {
  const hostId = getWorktreeExecutionHostId(
    args.worktree,
    args.repoMap.get(args.worktree.repoId),
    args.defaultHostId
  )
  const plan =
    args.occurrencePlan ??
    planSidebarRows({
      groupBy: args.groupBy,
      sortBy: 'smart',
      worktrees: [...(args.visibleWorktrees ?? args.worktrees)],
      repoMap: args.repoMap,
      prGroupOf: createSidebarPRGroupReader(args.repoMap, args.prCache),
      workspaceStatuses: args.workspaceStatuses,
      projectOrderBy: 'manual',
      lineageById: { ...args.worktreeLineageById },
      lineageParentIdentities: args.lineageParentIdentities,
      worktreeMap: new Map(args.worktrees.map((row) => [row.id, row])),
      nestLineage: true,
      projectGroups: args.projectGroups,
      placeholderRepoIds: new Set(),
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingCreations: [],
      projectGrouping: args.projectGrouping,
      folderWorkspaces: [],
      defaultHostId: args.defaultHostId,
      pinnedDisplayPolicy: args.pinnedDisplayPolicy,
      filterRepoIds: args.filterRepoIds ?? []
    }).occurrencePlan
  const occurrence = plan.preferredByIdentity.get(getWorktreeHostIdentity(args.worktree))
  if (!occurrence) {
    return []
  }
  const keys = [`host:${hostId}`]
  // Why all of a card's keys: a Group by branch card folds every member's lineage
  // group together, so revealing a child must unfold the whole card, at any depth.
  // Why by key: a parent the plan kept only as a key still names an ancestor, and
  // the plan's own occurrence carries the row this walk needs.
  const occurrenceByKey = new Map(
    [...plan.preferredByIdentity.values()].map((candidate) => [candidate.key, candidate])
  )
  const ancestors: Worktree[] = []
  let ancestor = occurrence.parent
  while (ancestor) {
    const resolved = occurrenceByKey.get(ancestor.key) ?? ancestor
    if (resolved.row) {
      ancestors.unshift(resolved.row)
    }
    ancestor = resolved.parent
  }
  const keysByLevel = args.mergeSameBranchCards
    ? foldKeysByAncestor({
        plan,
        ancestors,
        repoMap: args.repoMap,
        projectIndex: buildProjectGroupingIndex(args.projectGrouping),
        defaultHostId: args.defaultHostId
      })
    : ancestors.map((worktree) => [getWorktreeLineageGroupKey(worktree)])
  for (const levelKeys of keysByLevel) {
    keys.push(...levelKeys)
  }
  let path: typeof occurrence.sectionPath | undefined = occurrence.sectionPath
  while (path) {
    keys.push(args.hostScopedGroups ? getHostSectionCollapseKey(path.key, hostId) : path.key)
    path = path.parent
  }
  return [...new Set(keys)].filter((key) => args.collapsedGroups.has(key))
}
