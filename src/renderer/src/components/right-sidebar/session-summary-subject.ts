import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isSessionSummaryHostSupported } from '../../../../shared/session-summary-host'
import { getFocusedAgentPaneKeyForWorktree } from '@/components/sidebar/focused-agent-row-highlight'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

/** Exactly what resolving the pane's subject reads, so tests can build a partial state. */
export type SessionSummarySubjectState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeTabType'
  | 'activeTabId'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'migrationUnsupportedByPtyId'
>

/**
 * The agent session the summary pane reports on: the agent pane focused in the
 * active workspace, and nothing else.
 *
 * Deliberately strict. Another agent in the same workspace is not this pane's
 * subject, and guessing the most recently active one shows a summary of a session
 * the user is not looking at — worse than an empty pane, because it reads as
 * though it were theirs.
 *
 * A focused hibernated pane still qualifies: the hook server keeps a
 * provider-session remnant for a dropped status row (`server-cleanup.ts`), which
 * is all the fold needs to summarize a finished session.
 */
export function selectSessionSummaryPaneKey(
  state: SessionSummarySubjectState,
  worktreeId: string | null
): string | null {
  return worktreeId ? getFocusedAgentPaneKeyForWorktree(state, worktreeId) : null
}

export function useSessionSummaryPaneKey(): string | null {
  const worktreeId = useAppStore((state) => state.activeWorktreeId)
  return useAppStore((state) => selectSessionSummaryPaneKey(state, worktreeId))
}

/**
 * The host the active workspace runs on.
 *
 * The pane needs it for two things main cannot answer for the pane itself: a session on
 * a paired Orca server is folded *there*, and a paired host's status rows carry no
 * connection, so the request is the only thing that says the session is not local.
 */
export function useSessionSummaryExecutionHostId(): ExecutionHostId | null {
  const worktreeId = useAppStore((state) => state.activeWorktreeId)
  return useAppStore((state) =>
    worktreeId ? getExecutionHostIdForWorktree(state, worktreeId) : null
  )
}

/** Whether the pane's workspace host can produce a brief at all. */
export function useSessionSummaryHostSupported(): boolean {
  const hostId = useSessionSummaryExecutionHostId()
  return isSessionSummaryHostSupported(hostId)
}

/** Whether this window can fold at all: the desktop bridge owns it, and a paired web
 *  client composes no `sessionSummary` implementation. */
export function hasSessionSummaryBridge(): boolean {
  return typeof window.api?.sessionSummary?.open === 'function'
}
