import type { HostScopedWorktreeKey } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  lineageIdentities,
  type WorktreeLineageSource
} from '../../../../../../shared/sidebar-list/worktree-lineage-range'
import type {
  BranchGroupMember,
  WorktreeRow
} from '../../../../../../shared/sidebar-list/row-types'

export type BranchGroupMerge = {
  primaryRow: WorktreeRow
  members: BranchGroupMember[]
  /** One row per member, in `members` order. */
  memberRows: readonly WorktreeRow[]
}

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

export function buildMergedRow(
  merge: BranchGroupMerge,
  branchGroupKey: string,
  collapsedGroups: ReadonlySet<string>
): WorktreeRow {
  const childWorktreeIds = unionChildWorktreeIds(merge.memberRows)
  // Why the sum, not the id count: ids can repeat across hosts, and the card counts rows.
  const childCount = merge.memberRows.reduce((sum, row) => sum + row.lineageChildCount, 0)
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
