// Facts and snapshots for one pane.
//
// The summary is a materialized view: cheap status facts are always available (no fold,
// no transcript read), and the ledger section is whatever the last fold produced.
import type { AgentStatusState, AgentType } from '../../shared/agent-status-types'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type {
  SessionSummaryFacts,
  SessionSummaryLedger,
  SessionSummarySnapshot,
  SessionSummaryStatus
} from '../../shared/session-summary-types'
import { emptySessionSummaryLedger, hasProducedLedger } from './session-summary-ledger'

// The subset of a status row the summary needs; optional throughout because
// hook rows arrive from hosts of varying vintage (see agent-status-types.ts).
export type SessionSummaryStatusEntry = {
  agentType?: AgentType
  providerSession?: AgentProviderSessionMetadata
  /** Set on rows ingested from an SSH relay: the host that wrote the transcript. */
  connectionId?: string | null
  state?: AgentStatusState
  stateStartedAt?: number
  turnStartedAt?: number
  updatedAt?: number
  prompt?: string
}

export const IDLE_FOLD = { running: false, completedChunks: 0, totalChunks: 0 } as const

/** Cheap deterministic facts: no LLM, no transcript read. */
export function buildSessionSummaryFacts(
  paneKey: string,
  entry: SessionSummaryStatusEntry | undefined,
  ledger: SessionSummaryLedger,
  messageCount: number
): SessionSummaryFacts {
  return {
    paneKey,
    ...(entry?.agentType ? { agentType: entry.agentType } : {}),
    ...(entry?.state ? { state: entry.state } : {}),
    ...(entry?.stateStartedAt ? { stateStartedAt: entry.stateStartedAt } : {}),
    ...(entry?.turnStartedAt ? { turnStartedAt: entry.turnStartedAt } : {}),
    ...(entry?.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    prompt: entry?.prompt ?? '',
    messageCount,
    foldedThrough: ledger.foldedThrough,
    backlogCount: Math.max(0, messageCount - ledger.foldedThrough)
  }
}

/** A snapshot from this machine's own cache — the shape a paired host relays instead. */
export function buildLocalSessionSummarySnapshot(args: {
  paneKey: string
  entry: SessionSummaryStatusEntry | undefined
  ledger: SessionSummaryLedger | null
  messageCount: number
  seenThrough: number
  status: SessionSummaryStatus | undefined
  fold: SessionSummarySnapshot['fold']
  error?: string
}): SessionSummarySnapshot {
  // Why: a cache written before this rule can still hold an empty ledger, and relaying it
  // is what let a blank body read as "Up to date".
  const ledger = args.ledger && hasProducedLedger(args.ledger) ? args.ledger : null
  return {
    paneKey: args.paneKey,
    status: args.status ?? (ledger ? 'ready' : 'unavailable'),
    facts: buildSessionSummaryFacts(
      args.paneKey,
      args.entry,
      ledger ?? emptySessionSummaryLedger(),
      args.messageCount
    ),
    ledger,
    seenThrough: args.seenThrough,
    fold: args.fold,
    ...(args.error ? { error: args.error } : {})
  }
}
