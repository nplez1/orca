// Session summary: a materialized view over an agent session's transcript,
// folded only while the user reads the summary pane. See docs/reference/session-summary.md.
import type { AgentStatusState, AgentType } from './agent-status-types'
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

export type SessionSummaryStatus = 'unavailable' | 'folding' | 'ready' | 'failed'

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
  /** Fold-brain configuration, resolved from the user's text-generation settings. */
  foldParams?: ResolvedSourceControlAiGenerationParams | null
}

export type SessionSummaryCloseRequest = {
  paneKey: string
  /** Timeline length the viewer actually saw; becomes the next seenThrough. */
  seenTimelineCount: number
}

export const SESSION_SUMMARY_TEXT_MAX_LENGTH = 600
export const SESSION_SUMMARY_LIST_MAX_ITEMS = 12

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isSessionSummaryOpenRequest(value: unknown): value is SessionSummaryOpenRequest {
  return isRecord(value) && typeof value.paneKey === 'string'
}

export function isSessionSummaryCloseRequest(value: unknown): value is SessionSummaryCloseRequest {
  return (
    isRecord(value) &&
    typeof value.paneKey === 'string' &&
    typeof value.seenTimelineCount === 'number'
  )
}
