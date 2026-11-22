import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { HostScopedWorktreeKey } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  lineageIdentities,
  type WorktreeLineageSource
} from '../../../../../../shared/sidebar-list/worktree-lineage-range'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/sections/group-keys'
import type { ProjectGroupingIndex } from '../../../../../../shared/sidebar-list/sections/project-section-grouping'
import type {
  BranchGroupMember,
  Row,
  WorktreeRow
} from '../../../../../../shared/sidebar-list/row-types'
import { buildHostOrderedMembers, getBranchGroupKeyForWorktree } from './branch-groups'

type BranchGroupMerge = {
  primaryRow: WorktreeRow
  members: BranchGroupMember[]
  /** One row per member, in `members` order. */
  memberRows: readonly WorktreeRow[]
}

function getRowBranchGroupKey(
  row: WorktreeRow,
  repoMap: ReadonlyMap<string, Repo>,
  projectIndex: ProjectGroupingIndex | null
): string | null {
  // Why: a lineage child renders inside its parent's subtree, so only roots are
  // candidates; a root with children stays one, or its hosts would split apart.
  if (row.depth !== 0 || row.sectionKey === PINNED_GROUP_KEY) {
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

/** Rows nested under `rows[start]`; they end at the next row that is not deeper. */
function subtreeEnd(rows: readonly Row[], start: number): number {
  const startRow = rows[start]
  const parentDepth =
    startRow?.type === 'item' || startRow?.type === 'folder-workspace' ? startRow.depth : -1
  let end = start + 1
  while (end < rows.length) {
    const row = rows[end]
    const depth = row.type === 'item' || row.type === 'folder-workspace' ? row.depth : null
    if (depth === null || depth <= parentDepth) {
      break
    }
    end += 1
  }
  return end
}

/** Every member's children, so the merged card carries the group's whole subtree. */
function unionChildWorktreeIds(memberRows: readonly WorktreeRow[]): readonly string[] {
  const ids = new Set<string>()
  for (const row of memberRows) {
    for (const id of row.lineageChildWorktreeIds ?? []) {
      ids.add(id)
    }
  }
  return [...ids]
}

function unionDescendantIdentities(
  memberRows: readonly WorktreeRow[]
): WorktreeLineageSource | undefined {
  const sources = memberRows.flatMap((row) =>
    row.lineageDescendantIdentities ? [row.lineageDescendantIdentities] : []
  )
  if (sources.length <= 1) {
    return sources[0]
  }
  const identities = new Set<HostScopedWorktreeKey>()
  for (const source of sources) {
    for (const identity of lineageIdentities(source)) {
      identities.add(identity)
    }
  }
  return [...identities]
}

function buildMergedRow(
  merge: BranchGroupMerge,
  branchGroupKey: string,
  collapsedGroups: ReadonlySet<string>
): WorktreeRow {
  const childWorktreeIds = unionChildWorktreeIds(merge.memberRows)
  const childCount =
    childWorktreeIds.length > 0
      ? childWorktreeIds.length
      : merge.memberRows.reduce((sum, row) => sum + row.lineageChildCount, 0)
  const descendants = unionDescendantIdentities(merge.memberRows)
  // Why: one card owns every member's children, so its chip folds all of their
  // lineage groups at once — a half-collapsed union would strand rows.
  const lineageCollapseKeys = merge.memberRows.flatMap((row) =>
    row.lineageGroupKey ? [row.lineageGroupKey] : []
  )
  return {
    ...merge.primaryRow,
    // The dropdown names the host, so the mixed-host chip is redundant here.
    hostContextLabel: undefined,
    branchGroupKey,
    branchGroup: merge.members,
    lineageChildCount: childCount,
    ...(childWorktreeIds.length > 0 ? { lineageChildWorktreeIds: childWorktreeIds } : {}),
    ...(descendants ? { lineageDescendantIdentities: descendants } : {}),
    ...(lineageCollapseKeys.length > 0
      ? {
          lineageGroupKey: merge.primaryRow.lineageGroupKey ?? lineageCollapseKeys[0],
          lineageCollapsed: lineageCollapseKeys.some((key) => collapsedGroups.has(key)),
          lineageCollapseKeys
        }
      : {})
  }
}

/**
 * Consolidates same-branch worktree rows spanning two or more hosts into a
 * single row (Group by branch), drawing every member's children beneath it.
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
  const candidatesByBranch = new Map<string, WorktreeRow[]>()
  for (const row of rows) {
    if (row.type !== 'item') {
      continue
    }
    const key = getRowBranchGroupKey(row, repoMap, projectIndex)
    if (!key) {
      continue
    }
    const existing = candidatesByBranch.get(key)
    if (existing) {
      existing.push(row)
    } else {
      candidatesByBranch.set(key, [row])
    }
  }
  if (candidatesByBranch.size === 0) {
    return [...rows]
  }

  const indexByRowKey = new Map<string, number>()
  rows.forEach((row, index) => {
    if (row.type === 'item') {
      indexByRowKey.set(row.rowKey, index)
    }
  })

  const mergesByPrimaryRowKey = new Map<
    string,
    { merged: WorktreeRow; memberRowKeys: readonly string[] }
  >()
  const consumedRowKeys = new Set<string>()
  for (const [key, candidates] of candidatesByBranch) {
    if (candidates.length < 2) {
      continue
    }
    const merge = buildBranchGroupMerge(candidates, repoMap, defaultHostId, hostLabelById)
    if (!merge) {
      continue
    }
    const memberRowKeys = merge.memberRows.map((row) => row.rowKey)
    if (memberRowKeys.some((rowKey) => !indexByRowKey.has(rowKey))) {
      continue
    }
    mergesByPrimaryRowKey.set(merge.primaryRow.rowKey, {
      merged: buildMergedRow(merge, key, collapsedGroups),
      memberRowKeys
    })
    for (const rowKey of memberRowKeys) {
      if (rowKey !== merge.primaryRow.rowKey) {
        consumedRowKeys.add(rowKey)
      }
    }
  }
  if (mergesByPrimaryRowKey.size === 0) {
    return [...rows]
  }

  const result: Row[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row.type === 'item') {
      const merge = mergesByPrimaryRowKey.get(row.rowKey)
      if (merge) {
        result.push(merge.merged)
        // Why: the card stands in for every host it merged, so it draws their
        // children as one subtree — the union — or none of them when folded.
        if (merge.merged.lineageCollapsed !== true) {
          for (const memberRowKey of merge.memberRowKeys) {
            const memberIndex = indexByRowKey.get(memberRowKey)!
            const end = subtreeEnd(rows, memberIndex)
            for (let child = memberIndex + 1; child < end; child += 1) {
              result.push(rows[child])
            }
          }
        }
        index = subtreeEnd(rows, index) - 1
        continue
      }
      if (consumedRowKeys.has(row.rowKey)) {
        index = subtreeEnd(rows, index) - 1
        continue
      }
    }
    result.push(row)
  }
  return result
}
