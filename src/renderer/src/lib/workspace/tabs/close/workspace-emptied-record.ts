import {
  hasWorkspaceEmptiedRecord,
  recordWorkspaceEmptiedTombstone
} from '../../../../../../shared/workspace-layout/terminal-surfaces/closed-terminal-tab-tombstones'
import type {
  ClosedTerminalTabTombstone,
  ClosedTerminalTabTombstonesByTabId
} from '../../../../../../shared/workspace-layout/terminal-surfaces/closed-terminal-tab-tombstones'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { WorkspaceContentState } from '@/lib/workspace-emptied-on-purpose'
import { hasNoRenderableWorkspaceContent } from '@/lib/workspace-emptied-on-purpose'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/workspace/identity/floating-workspace-id'

type EmptiedRecordState = WorkspaceContentState & {
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
  closedTerminalTabTombstonesByTabId?: ClosedTerminalTabTombstonesByTabId
}

export type EmptiedWorkspaceRecord = {
  recordId: string
  record: ClosedTerminalTabTombstone
  patch: { closedTerminalTabTombstonesByTabId: ClosedTerminalTabTombstonesByTabId }
}

/**
 * The record a user close that leaves this workspace with nothing to render produces, or null when
 * it must not be recorded.
 *
 * Why a workspace-scoped record rather than a terminal close record: a chat, browser or editor
 * close writes none, so without this the workspace reads as Sleeping once it leaves the screen and
 * seeds a fresh terminal on the next open or restart (#96).
 *
 * Why re-check the workspace: callers capture this before the close lands, and a close can be
 * refused (a running process, a cancelled save) or leave a sibling tab behind.
 */
export function prepareEmptiedWorkspaceRecord(
  state: EmptiedRecordState,
  worktreeId: string | null | undefined,
  now = Date.now()
): EmptiedWorkspaceRecord | null {
  // The floating panel is not a workspace; emptying it is a keyboard-ownership question, not this.
  if (!worktreeId || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return null
  }
  if (!hasNoRenderableWorkspaceContent(state, worktreeId)) {
    return null
  }
  if (hasWorkspaceEmptiedRecord(state.closedTerminalTabTombstonesByTabId, worktreeId, now)) {
    return null
  }
  const recordId = createNonSecureContextUuid()
  const record: ClosedTerminalTabTombstone = {
    closedAt: now,
    worktreeId,
    reason: 'user',
    scope: 'workspace'
  }
  return {
    recordId,
    record,
    patch: {
      closedTerminalTabTombstonesByTabId: recordWorkspaceEmptiedTombstone(
        state.closedTerminalTabTombstonesByTabId,
        worktreeId,
        recordId,
        now
      )
    }
  }
}

/**
 * Hands the record to main, which owns this field: a renderer save omits it, so the window cannot be
 * what makes it outlive a restart. Sent as a one-key entries patch, the seam built for "this window
 * changed these keys of a keyed record" — it cannot shrink what main holds.
 */
export function commitEmptiedWorkspaceRecord(
  state: EmptiedRecordState,
  worktreeId: string,
  prepared: EmptiedWorkspaceRecord
): void {
  // Only the workspace on screen names the partition it lives in here; a background workspace's
  // record stays in this window's copy, which is where the surface and the sleep glyph read it.
  const hostId =
    state.activeWorktreeId === worktreeId ? state.activeWorkspaceExecutionHostId : undefined
  const target = hostId && hostId !== LOCAL_EXECUTION_HOST_ID ? hostId : undefined
  // Why optional: an older preload, and the paired web client, write whole fields only.
  void globalThis.window?.api?.session
    ?.patchEntries?.(
      {
        fields: {},
        entries: {
          closedTerminalTabTombstonesByTabId: {
            set: { [prepared.recordId]: prepared.record },
            remove: []
          }
        }
      },
      target
    )
    ?.catch((error: unknown) => {
      console.warn('[workspace-emptied] main did not keep the emptied-workspace record', error)
    })
}

/** The same, for callers holding their own store writer (a slice rather than the app store). */
export function recordEmptiedWorkspaceWith(
  state: EmptiedRecordState,
  worktreeId: string | null | undefined,
  write: (patch: EmptiedWorkspaceRecord['patch']) => void
): void {
  const prepared = prepareEmptiedWorkspaceRecord(state, worktreeId)
  if (!prepared || !worktreeId) {
    return
  }
  write(prepared.patch)
  commitEmptiedWorkspaceRecord(state, worktreeId, prepared)
}
