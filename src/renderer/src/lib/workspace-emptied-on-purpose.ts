import { CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS } from '../../../shared/closed-terminal-tab-tombstones'
import type { ClosedTerminalTabTombstonesByTabId } from '../../../shared/closed-terminal-tab-tombstones'

type TabRow = readonly { id: string }[]

// Why optional: cards and panes mount against partial store mocks, and a missing slice reads empty.
export type WorkspaceContentState = {
  activeWorktreeId?: string | null
  tabsByWorktree?: Record<string, TabRow> | null
  unifiedTabsByWorktree?: Record<string, TabRow> | null
  browserTabsByWorktree?: Record<string, TabRow> | null
  openFiles?: readonly { worktreeId: string }[] | null
  closedTerminalTabTombstonesByTabId?: ClosedTerminalTabTombstonesByTabId
}

/** Nothing to render: no terminal, unified, browser or editor row for this workspace. */
export function hasNoRenderableWorkspaceContent(
  state: WorkspaceContentState,
  worktreeId: string
): boolean {
  return (
    (state.tabsByWorktree?.[worktreeId]?.length ?? 0) === 0 &&
    (state.unifiedTabsByWorktree?.[worktreeId]?.length ?? 0) === 0 &&
    (state.browserTabsByWorktree?.[worktreeId]?.length ?? 0) === 0 &&
    !(state.openFiles ?? []).some((file) => file.worktreeId === worktreeId)
  )
}

/** A tab of this workspace was closed on purpose, and the record has not expired. */
export function hasFreshClosedTabRecord(
  closedTerminalTabTombstonesByTabId: ClosedTerminalTabTombstonesByTabId | undefined,
  worktreeId: string,
  now: number
): boolean {
  return Object.values(closedTerminalTabTombstonesByTabId ?? {}).some(
    (record) =>
      record.worktreeId === worktreeId &&
      now - record.closedAt <= CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS
  )
}

/**
 * The user emptied this workspace: nothing is left to render and its last tab was closed on
 * purpose, so the absence of a surface is the empty-tabs state rather than sleep (#96).
 *
 * Why both halves: the close record alone also matches a workspace still holding slept chat tabs or
 * an open editor file, and an empty row alone cannot tell "the user closed it" from "never
 * initialized".
 */
export function isWorkspaceEmptiedOnPurpose(
  state: WorkspaceContentState,
  worktreeId: string,
  now: number
): boolean {
  return (
    hasNoRenderableWorkspaceContent(state, worktreeId) &&
    hasFreshClosedTabRecord(state.closedTerminalTabTombstonesByTabId, worktreeId, now)
  )
}

/** The selected workspace has nothing to render — the surface on screen is its empty-tabs state. */
export function isActiveEmptyWorkspace(state: WorkspaceContentState, worktreeId: string): boolean {
  return state.activeWorktreeId === worktreeId && hasNoRenderableWorkspaceContent(state, worktreeId)
}
