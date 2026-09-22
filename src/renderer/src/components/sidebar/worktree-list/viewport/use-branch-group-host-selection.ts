import { useCallback, useLayoutEffect, useRef } from 'react'

import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import type { HostSectionRow } from '../../host-section-rows'
import type { BranchGroupMember } from '../grouping/row-types'

type BranchGroupHostTarget = { member: BranchGroupMember; rowKey: string }

/** The row must be found by group key, not `worktree`: a merged row always holds
 *  its local-first member while the card can be showing any host. */
export function findBranchGroupHostTarget(
  rows: readonly HostSectionRow[],
  groupKey: string,
  hostId: ExecutionHostId
): BranchGroupHostTarget | null {
  for (const row of rows) {
    if (row.type !== 'item' || row.branchGroupKey !== groupKey) {
      continue
    }
    const member = row.branchGroup?.find((candidate) => candidate.hostId === hostId)
    if (member) {
      return { member, rowKey: row.rowKey }
    }
  }
  return null
}

/**
 * Picking a host in a Group by branch dropdown must also activate that host's
 * workspace. Otherwise the merged card swaps to a host that is not the active
 * one, so it renders unselected and the previously active sibling disappears
 * behind it with nothing in the list appearing focused.
 *
 * `onImmediateActivate` is the click-path DOM fast-forward; the store activation
 * is what actually changes the selection, and React batches both into one render.
 */
export function useBranchGroupHostSelection(args: {
  rows: readonly HostSectionRow[]
  setBranchGroupHost: (groupKey: string, hostId: ExecutionHostId) => void
  onImmediateActivate: (worktreeId: string, rowKey: string | undefined) => void
}): (groupKey: string, hostId: ExecutionHostId) => void {
  const { rows, setBranchGroupHost, onImmediateActivate } = args
  const rowsRef = useRef(rows)
  useLayoutEffect(() => {
    rowsRef.current = rows
  }, [rows])
  return useCallback(
    (groupKey: string, hostId: ExecutionHostId) => {
      setBranchGroupHost(groupKey, hostId)
      const target = findBranchGroupHostTarget(rowsRef.current, groupKey, hostId)
      if (!target) {
        return
      }
      onImmediateActivate(target.member.worktree.id, target.rowKey)
      void activateWorktreeFromSidebar(target.member.worktree.id, target.member.hostId)
    },
    [setBranchGroupHost, onImmediateActivate]
  )
}
