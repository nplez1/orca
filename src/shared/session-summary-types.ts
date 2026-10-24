// Session summary: a materialized view over an agent session's transcript,
// folded only while the user reads the summary pane. See docs/reference/session-summary.md.
import type { AgentStatusState, AgentType } from './agent-status-types'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from './agent-session-resume'
import type { ResolvedSourceControlAiGenerationParams } from './source-control-ai'

export const SESSION_SUMMARY_TIMELINE_KINDS = [
  'milestone',
  'decision',
  'error',
  'needs-input',
  'tool-burst',
  'user-input'
] as const
export type SessionSummaryTimelineKind = (typeof SESSION_SUMMARY_TIMELINE_KINDS)[number]

export type SessionSummaryTimelineEntry = {
  /** Stable id assigned when the entry is appended; keys the renderer's lists. */
  id: string
  kind: SessionSummaryTimelineKind
  text: string
  /** Anchor: transcript message index this entry derives from. */
  sourceIndex: number
}

/** What an extract produces: no id yet, the ledger assigns one on append. */
export type SessionSummaryTimelineDeltaEntry = Omit<SessionSummaryTimelineEntry, 'id'>

export type SessionSummaryLedger = {
  goal: string | null
  plan: string[]
  inProgress: string | null
  done: string[]
  blockers: string[]
  decisions: string[]
  // Why not trimmed: entries are counted by index ("since you last looked"),
  // so dropping one silently rewrites history. Extract prompts bound growth per chunk.
  timeline: SessionSummaryTimelineEntry[]
  /** Transcript message index through which this ledger is folded (exclusive). */
  foldedThrough: number
  foldedAt: number | null
}

/** What one chunk extract (or one merged fold) contributes to a ledger. */
export type SessionSummaryLedgerDelta = {
  goal?: string | null
  plan?: string[]
  inProgress?: string | null
  done?: string[]
  blockers?: string[]
  decisions?: string[]
  timeline?: SessionSummaryTimelineDeltaEntry[]
}

/** Deterministic facts shown before any fold runs. Cheap: no LLM, no transcript read. */
export type SessionSummaryFacts = {
  paneKey: string
  agentType?: AgentType
  state?: AgentStatusState
  stateStartedAt?: number
  turnStartedAt?: number
  updatedAt?: number
  prompt: string
  /** Transcript messages known at last read; 0 until the first read completes. */
  messageCount: number
  foldedThrough: number
  backlogCount: number
}

export type SessionSummaryFoldProgress = {
  running: boolean
  completedChunks: number
  totalChunks: number
}

/**
 * `unsupported-host` is an incapacity, not a failure: the workspace runs on a host kind
 * this build cannot parse (a newer one), so it neither reads a transcript nor folds here.
 */
export type SessionSummaryStatus =
  | 'unavailable'
  | 'unsupported-host'
  | 'folding'
  | 'ready'
  | 'failed'

export type SessionSummarySnapshot = {
  paneKey: string
  status: SessionSummaryStatus
  facts: SessionSummaryFacts | null
  ledger: SessionSummaryLedger | null
  /** Timeline entries at or after this count are new since the last view. */
  seenThrough: number
  fold: SessionSummaryFoldProgress
  error?: string
}

export type SessionSummaryOpenRequest = {
  paneKey: string
  /**
   * The execution host owning the pane's workspace, so the fold reads the transcript
   * where it lives. Absent means the local host — what a caller that knows nothing
   * about host routing sends, and what an older client sends.
   */
  executionHostId?: string
  /** Fold-brain configuration, resolved from the user's text-generation settings. */
  foldParams?: ResolvedSourceControlAiGenerationParams | null
  /**
   * The session the viewer has on screen, as the viewer's own store knows it.
   *
   * Why it travels: the process that folds is often not the process that holds the row.
   * A paired host folds panes whose status rows live on the client, and this desktop folds
   * panes whose rows were cleared on reconnect — both then read no identity at all and
   * reported "no readable transcript" for a session sitting right in front of the reader.
   * Absent means "use this process's own row", which stays the rule for older callers.
   */
  session?: SessionSummarySessionRef
}

/** The identity half of a status row: which agent, and which of its sessions. */
export type SessionSummarySessionRef = {
  agentType?: AgentType
  providerSession?: AgentProviderSessionMetadata
}

export type SessionSummaryCloseRequest = {
  paneKey: string
  /** Timeline length the viewer actually saw; becomes the next seenThrough. */
  seenTimelineCount: number
}

export const SESSION_SUMMARY_TEXT_MAX_LENGTH = 600
export const SESSION_SUMMARY_LIST_MAX_ITEMS = 12

/**
 * The error a paired host answers with when it predates the host-fold methods.
 * A server updates on its own schedule, so this names the remedy instead of
 * reporting a fold that failed.
 */
export const SESSION_SUMMARY_HOST_OUTDATED_MESSAGE = 'host-outdated'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isSessionSummaryOpenRequest(value: unknown): value is SessionSummaryOpenRequest {
  if (!isRecord(value) || typeof value.paneKey !== 'string') {
    return false
  }
  // Optional, so a request from a client that predates host-aware folding stays valid.
  return value.executionHostId === undefined || typeof value.executionHostId === 'string'
}

export function isSessionSummaryCloseRequest(value: unknown): value is SessionSummaryCloseRequest {
  return (
    isRecord(value) &&
    typeof value.paneKey === 'string' &&
    typeof value.seenTimelineCount === 'number'
  )
}

/**
 * A requested session identity, narrowed to what a fold can use.
 *
 * Checked rather than cast: the request crosses a process boundary (and, for a paired
 * host, a machine boundary), and an identity the folding side cannot read is worse than
 * none — it would make the pane claim a session it cannot brief.
 */
export function parseSessionSummarySessionRef(value: unknown): SessionSummarySessionRef | null {
  if (value === undefined || value === null) {
    return null
  }
  if (!isRecord(value)) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(value.providerSession)
  const agentType: AgentType | undefined =
    typeof value.agentType === 'string' ? value.agentType : undefined
  if (!providerSession) {
    return agentType ? { agentType } : null
  }
  return {
    ...(agentType ? { agentType } : {}),
    providerSession
  }
}
