import { defaultRangeExtractor } from '@tanstack/react-virtual'
import type { Range } from '@tanstack/react-virtual'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { aiVaultSubagentParentKey } from '../../../../shared/ai-vault-subagent-nesting'
import type { AiVaultSessionGroup, AiVaultSessionListGroup } from './ai-vault-session-filters'
import {
  getActiveStickyHeaderIndex,
  getPreviousStickyHeaderIndex
} from '../sidebar/worktree-list/viewport/virtual-rows'

export const VAULT_GROUP_HEADER_ROW_HEIGHT = 32
export const VAULT_SESSION_ROW_HEIGHT = 98

// The nesting model hands out a forest, so this only bounds a legitimately
// deep sub-agent chain — never a cycle.
const MAX_SUBAGENT_NESTING_DEPTH = 8

export type AiVaultListRow =
  | { type: 'group'; group: AiVaultSessionGroup }
  | {
      type: 'session'
      groupKey: string
      session: AiVaultSession
      /** 0 for a top-level row; 1+ for a sub-agent nested under its parent. */
      subagentDepth: number
      /** Sub-agent rows held for this session; 0 hides the row's disclosure. */
      subagentChildCount: number
      subagentChildrenExpanded: boolean
    }

/**
 * Flattens grouped sessions into list rows, unfolding a parent's sub-agent
 * children beneath it while it is expanded. A collapsed group contributes its
 * header only.
 */
export function buildVaultListRows(args: {
  groups: readonly AiVaultSessionListGroup[]
  collapsedGroups: ReadonlySet<string>
  childrenByParentId: ReadonlyMap<string, readonly AiVaultSession[]>
  expandedSubagentParentIds: ReadonlySet<string>
}): AiVaultListRow[] {
  const rows: AiVaultListRow[] = []

  const appendSession = (
    session: AiVaultSession,
    groupKey: string,
    subagentDepth: number
  ): void => {
    const children = args.childrenByParentId.get(aiVaultSubagentParentKey(session)) ?? []
    const subagentChildrenExpanded =
      children.length > 0 && args.expandedSubagentParentIds.has(session.id)
    rows.push({
      type: 'session',
      groupKey,
      session,
      subagentDepth,
      subagentChildCount: children.length,
      subagentChildrenExpanded
    })
    if (!subagentChildrenExpanded || subagentDepth >= MAX_SUBAGENT_NESTING_DEPTH) {
      return
    }
    for (const child of children) {
      appendSession(child, groupKey, subagentDepth + 1)
    }
  }

  for (const sessionGroup of args.groups) {
    const label = sessionGroup.label
    if (label !== null) {
      rows.push({ type: 'group', group: { ...sessionGroup, label } })
    }
    if (label === null || !args.collapsedGroups.has(sessionGroup.key)) {
      for (const session of sessionGroup.sessions) {
        appendSession(session, sessionGroup.key, 0)
      }
    }
  }
  return rows
}

export function getVaultStickyHeaderIndexes(rows: readonly AiVaultListRow[]): number[] {
  const indexes: number[] = []
  rows.forEach((row, index) => {
    if (row.type === 'group') {
      indexes.push(index)
    }
  })
  return indexes
}

export function extractVaultVirtualRowIndexes(args: {
  range: Range
  stickyHeaderIndexes: readonly number[]
}): number[] {
  const activeStickyHeaderIndex = getActiveStickyHeaderIndex(
    args.stickyHeaderIndexes,
    args.range.startIndex
  )
  if (activeStickyHeaderIndex === null) {
    return defaultRangeExtractor(args.range)
  }

  const previousStickyHeaderIndex = getPreviousStickyHeaderIndex(
    args.stickyHeaderIndexes,
    activeStickyHeaderIndex
  )
  return Array.from(
    new Set([
      activeStickyHeaderIndex,
      ...(previousStickyHeaderIndex === null ? [] : [previousStickyHeaderIndex]),
      ...defaultRangeExtractor(args.range)
    ])
  ).sort((a, b) => a - b)
}
