import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../../../shared/execution-host/execution-host'
import {
  PINNED_GROUP_KEY,
  getWorktreeLineageGroupKey
} from '../../../../../../shared/sidebar-list/sections/group-keys'
import type { ProjectGroupingIndex } from '../../../../../../shared/sidebar-list/sections/project-section-grouping'
import type {
  Row,
  WorktreeGroupBy,
  WorktreeRow
} from '../../../../../../shared/sidebar-list/row-types'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import { buildHostOrderedMembers, getBranchGroupKeyForWorktree } from './branch-groups'
import { buildMergedRow, type BranchGroupMerge } from './same-branch-merged-row'
import { buildRowForest, flattenRowForest, type RowNode } from './sidebar-row-forest'

/**
 * Whether same-branch rows may merge at all. Why: an explicit host scope or filter
 * splits rows into host sections, where a cross-host card has no home.
 */
export function shouldMergeSameBranchCards(args: {
  groupBy: WorktreeGroupBy
  mergeSameBranchWorkspaces: boolean
  workspaceHostScope: ExecutionHostScope
  visibleWorkspaceHostIds: readonly ExecutionHostId[] | null
}): boolean {
  return (
    args.groupBy === 'repo' &&
    args.mergeSameBranchWorkspaces &&
    args.workspaceHostScope === ALL_EXECUTION_HOSTS_SCOPE &&
    !args.visibleWorkspaceHostIds
  )
}

/** Which lineage groups a workspace's child chip folds, keyed by its lineage group key —
 * several when its card merged hosts, since the chip folds them as one. */
export function indexLineageFoldKeys(
  rows: readonly HostSectionRow[]
): Map<string, readonly string[]> {
  const keys = new Map<string, readonly string[]>()
  for (const row of rows) {
    if (row.type !== 'item' || row.lineageChildCount <= 0) {
      continue
    }
    const collapseKeys =
      row.lineageCollapseKeys ?? (row.lineageGroupKey ? [row.lineageGroupKey] : [])
    if (collapseKeys.length === 0) {
      continue
    }
    // Why every member: the hosts a card absorbed render no row of their own, and their
    // workspaces are exactly the ones a shortcut or a reveal arrives from.
    for (const worktree of row.branchGroup?.map((member) => member.worktree) ?? [row.worktree]) {
      keys.set(getWorktreeLineageGroupKey(worktree), collapseKeys)
    }
  }
  return keys
}

function getRowBranchGroupKey(
  row: WorktreeRow,
  repoMap: ReadonlyMap<string, Repo>,
  projectIndex: ProjectGroupingIndex | null
): string | null {
  // Why only the pinned section: candidates are grouped among siblings at one level,
  // so a card's own children can stack in turn; pinned rows render elsewhere.
  if (row.sectionKey === PINNED_GROUP_KEY) {
    return null
  }
  return getBranchGroupKeyForWorktree(row.worktree, repoMap, projectIndex)
}

function buildBranchGroupMerge(
  candidates: readonly WorktreeRow[],
  repoMap: ReadonlyMap<string, Repo>,
  defaultHostId: ExecutionHostId,
  hostLabelById: ReadonlyMap<string, string> | undefined
): BranchGroupMerge | null {
  const members = buildHostOrderedMembers(
    candidates.map((row) => ({ worktree: row.worktree, repo: row.repo })),
    repoMap,
    defaultHostId,
    hostLabelById
  )
  if (!members) {
    return null
  }
  const memberRows: WorktreeRow[] = []
  for (const member of members) {
    const row = candidates.find((candidate) => candidate.worktree === member.worktree)
    if (!row) {
      return null
    }
    memberRows.push(row)
  }
  return { primaryRow: memberRows[0]!, members, memberRows }
}

const NO_COLLAPSED_GROUPS: ReadonlySet<string> = new Set()

type MergeContext = {
  repoMap: ReadonlyMap<string, Repo>
  projectIndex: ProjectGroupingIndex | null
  defaultHostId: ExecutionHostId
  hostLabelById: ReadonlyMap<string, string> | undefined
  collapsedGroups: ReadonlySet<string>
}

type LevelMerge = {
  merged: WorktreeRow
  memberNodes: readonly RowNode[]
  /** Every member row but the primary's: the rows the card replaces. */
  consumedRowKeys: readonly string[]
}

/** Siblings of one branch on one level, keyed by the branch group they share. */
function planLevelMerge(nodes: readonly RowNode[], ctx: MergeContext): Map<string, LevelMerge> {
  const candidatesByBranch = new Map<string, { node: RowNode; row: WorktreeRow }[]>()
  for (const node of nodes) {
    const row = node.row
    if (row.type !== 'item') {
      continue
    }
    const key = getRowBranchGroupKey(row, ctx.repoMap, ctx.projectIndex)
    if (!key) {
      continue
    }
    const candidate = { node, row }
    const existing = candidatesByBranch.get(key)
    if (existing) {
      existing.push(candidate)
    } else {
      candidatesByBranch.set(key, [candidate])
    }
  }
  const merges = new Map<string, LevelMerge>()
  for (const [key, candidates] of candidatesByBranch) {
    if (candidates.length < 2) {
      continue
    }
    const merge = buildBranchGroupMerge(
      candidates.map((candidate) => candidate.row),
      ctx.repoMap,
      ctx.defaultHostId,
      ctx.hostLabelById
    )
    if (!merge) {
      continue
    }
    merges.set(merge.primaryRow.rowKey, {
      merged: buildMergedRow(merge, key, ctx.collapsedGroups),
      // Why by row identity: buildBranchGroupMerge hands back the very rows it was given.
      memberNodes: merge.memberRows.map(
        (row) => candidates.find((candidate) => candidate.row === row)!.node
      ),
      consumedRowKeys: merge.memberRows
        .filter((row) => row.rowKey !== merge.primaryRow.rowKey)
        .map((row) => row.rowKey)
    })
  }
  return merges
}

/** Counts the rows a level renders, so a card's chip agrees with the cards below it. */
function withRenderedChildCount(row: Row, children: readonly RowNode[]): Row {
  if (row.type !== 'item' && row.type !== 'folder-workspace') {
    return row
  }
  // Why not when folded: the rows are hidden by design, so the chip still counts them.
  if (row.lineageCollapsed === true || children.length === 0) {
    return row
  }
  return row.lineageChildCount === children.length
    ? row
    : { ...row, lineageChildCount: children.length }
}

function mergeLevel(nodes: readonly RowNode[], ctx: MergeContext): RowNode[] {
  const merges = planLevelMerge(nodes, ctx)
  const consumedRowKeys = new Set([...merges.values()].flatMap((merge) => merge.consumedRowKeys))
  const result: RowNode[] = []
  for (const node of nodes) {
    const merge = node.row.type === 'item' ? merges.get(node.row.rowKey) : undefined
    if (merge) {
      // Why: the card stands in for every host it merged, so it draws their
      // children as one subtree — the union — or none of them when folded.
      const children =
        merge.merged.lineageCollapsed === true
          ? []
          : merge.memberNodes.flatMap((member) => member.children)
      const mergedChildren = mergeLevel(children, ctx)
      result.push({
        row: withRenderedChildCount(merge.merged, mergedChildren),
        children: mergedChildren
      })
      continue
    }
    if (node.row.type === 'item' && consumedRowKeys.has(node.row.rowKey)) {
      continue
    }
    const children = mergeLevel(node.children, ctx)
    // Why after the children: a level that merged draws one card for several
    // workspaces, so the chip must count cards, not workspaces.
    result.push({ row: withRenderedChildCount(node.row, children), children })
  }
  return result
}

/**
 * Consolidates same-branch rows spanning two or more hosts into a single card
 * (Group by branch) at every depth, so a stack inside a stack stays stacked.
 * Single-host and ambiguous branches are returned untouched, so turning the
 * setting off needs no inverse pass.
 */
export function mergeSameBranchRows(
  rows: readonly Row[],
  repoMap: ReadonlyMap<string, Repo>,
  projectIndex: ProjectGroupingIndex | null,
  defaultHostId: ExecutionHostId,
  hostLabelById: ReadonlyMap<string, string> | undefined,
  collapsedGroups: ReadonlySet<string> = NO_COLLAPSED_GROUPS
): Row[] {
  const ctx: MergeContext = {
    repoMap,
    projectIndex,
    defaultHostId,
    hostLabelById,
    collapsedGroups
  }
  return flattenRowForest(mergeLevel(buildRowForest(rows), ctx))
}
