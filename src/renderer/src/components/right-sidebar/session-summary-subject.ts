import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getFocusedAgentPaneKeyForWorktree } from '@/components/sidebar/focused-agent-row-highlight'

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

/** Whether this window can fold at all: the desktop bridge owns it, and a paired web
 *  client composes no `sessionSummary` implementation. */
export function hasSessionSummaryBridge(): boolean {
  return typeof window.api?.sessionSummary?.open === 'function'
}
