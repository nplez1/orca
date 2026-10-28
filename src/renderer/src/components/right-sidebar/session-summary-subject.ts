import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isSessionSummaryHostSupported } from '../../../../shared/session-summary-host'
import type { SessionSummarySessionRef } from '../../../../shared/session-summary-types'
import { getFocusedAgentPaneKeyForWorktree } from '@/components/sidebar/focused-agent-row-highlight'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { RetainedAgentEntry } from '@/store/slices/agent-status/agent-status-contract'

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

/** The three places a pane's agent identity can be living, in the order it moves through them. */
export type SessionSummarySessionSources = {
  live?: AgentStatusEntry | undefined
  sleeping?: SleepingAgentSessionRecord | undefined
  retained?: RetainedAgentEntry | undefined
}

/**
 * The session the pane currently holds, from whichever record still knows it.
 *
 * Why not the live row alone: an idle Pi session is identity-only — the renderer drops its
 * status row and parks the identity in `sleepingAgentSessionsByPaneKey` while the session sits
 * waiting for a prompt, and a finished pane keeps it in `retainedAgentsByPaneKey`. A pane in
 * either state still has an agent on screen, so the summary pane must still brief it; reading
 * the live row alone made exactly the quiet sessions the ones that reported "no readable
 * transcript".
 *
 * A live row's identity is the freshest evidence, and the parked records are what it becomes
 * once the row is dropped. The row only wins when it *names a session*: a rebuilt row can carry
 * the agent type without any session metadata (its row was deleted when the session parked), and
 * preferring that shell over a parked identity blanked the pane and remounted it twice.
 */
export function resolveSessionSummarySessionRef(
  sources: SessionSummarySessionSources
): SessionSummarySessionRef | null {
  const live = sources.live
  if (live?.providerSession?.id) {
    return {
      ...(live.agentType ? { agentType: live.agentType } : {}),
      providerSession: live.providerSession
    }
  }
  const parked = resolveParkedSessionRef(sources)
  if (parked) {
    // Why the live agent type wins over the parked one: a pane can be relaunched with another
    // agent, and only the live row knows about the new one. A live row naming a *different*
    // agent than the parked session makes that session stale, so it is not used at all.
    return live?.agentType && live.agentType === parked.agentType
      ? { ...parked, agentType: live.agentType }
      : parked
  }
  return live?.agentType ? { agentType: live.agentType } : null
}

/** The identity a pane kept after its live row was dropped, if it kept one. */
function resolveParkedSessionRef(
  sources: SessionSummarySessionSources
): SessionSummarySessionRef | null {
  if (sources.sleeping) {
    return {
      agentType: sources.sleeping.agent,
      providerSession: sources.sleeping.providerSession
    }
  }
  const retained = sources.retained
  return retained
    ? {
        agentType: retained.agentType,
        ...(retained.entry.providerSession
          ? { providerSession: retained.entry.providerSession }
          : {})
      }
    : null
}

/**
 * The pane's session identity for the summary request.
 *
 * Selected as record references (stable in the store) and resolved through a memo, so a pane
 * whose row is dropped and rebuilt by the same session hands the hook an equal identity instead
 * of a new object — the fold must not restart on that transition.
 */
export function useSessionSummarySessionRef(
  paneKey: string | null
): SessionSummarySessionRef | null {
  const live = useAppStore((state) => (paneKey ? state.agentStatusByPaneKey[paneKey] : undefined))
  const sleeping = useAppStore((state) =>
    paneKey ? state.sleepingAgentSessionsByPaneKey[paneKey] : undefined
  )
  const retained = useAppStore((state) =>
    paneKey ? state.retainedAgentsByPaneKey[paneKey] : undefined
  )
  return useMemo(
    () => resolveSessionSummarySessionRef({ live, sleeping, retained }),
    [live, sleeping, retained]
  )
}
