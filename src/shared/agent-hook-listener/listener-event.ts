import type { AgentProcessPresence } from '../agent-process-presence'
import type { ParsedAgentStatusPayload, TurnEndDisposition } from '../agent-status-types'
import type { AgentHookSource } from '../agent-hook-relay'
import type { AgentProviderSessionMetadata } from '../agent-session-resume'
import type { ClaudeSettledRequest } from './claude-settled-permission-requests'

/** Execution-host turn record, saved with rows but private; turnEndedAt is the public fact. */
export type HostTurnRecord = {
  /** The provider session the turn keys belong to; another session starts a new record. */
  owner: string
  currentTurnKey: string
  completed?: { turnKey: string; endedAt: number }
}

export type AgentHookEventPayload = {
  paneKey: string
  agentPresence?: AgentProcessPresence
  /** Authenticated hook route that produced this event. */
  source?: AgentHookSource
  /** Ephemeral Orca launch identity stamped into the PTY env for this process. */
  launchToken?: string
  /** Host-minted live turn revision for guarded interrupt commands; never persisted. */
  hostTurnRevision?: string
  tabId?: string
  worktreeId?: string
  /** ingestRemote alone stamps mux identity; reject in-flight events from superseded SSH connections. */
  connectionId: string | null
  /** Direct prompt evidence; excludes cached text inherited from earlier events. */
  hasExplicitPrompt?: boolean
  /** The emitted nonterminal state is backed only by child state restored from disk. */
  restoredUnconfirmed?: true
  /** Distinguish duplicate delivery from same-text reruns when provider evidence permits. */
  promptInteractionKey?: string
  /** Raw agent hook event name, used by main-process transition guards. */
  hookEventName?: string
  /** Provider-owned turn identity (Claude UUID or opaque Grok prompt id). */
  providerPromptId?: string
  /** This row belongs to an observed Grok prompt boundary even when its opaque id is absent. */
  grokPromptBoundary?: true
  /** Active Claude compact generation, keyed by provider prompt identity. */
  compactTrigger?: 'manual' | 'auto'
  /** Claude tool-use identifier when the hook source exposes one. */
  toolUseId?: string
  /** Requests a relay saw end, sent only beside a replayed row; never stored on a status row. */
  claudeSettledRequests?: readonly ClaudeSettledRequest[]
  /** Claude agent/subagent identifier when the hook source exposes one. */
  toolAgentId?: string
  /** Claude teammate name carried by TeammateIdle. */
  teammateName?: string
  /** Agent/subagent type from the source hook payload, when present. */
  toolAgentType?: string
  /** Provider-owned conversation/session id needed to resume a sleeping agent. */
  providerSession?: AgentProviderSessionMetadata
  /** This event belongs to a claude CLI child of the pane's own pi subagent run, not to the pane's
   *  agent: `runId` is the child row it describes, `providerSession` its own conversation, and
   *  `transcriptPath` where that conversation is written. Main uses it to record the parent link
   *  beside the transcript so the session list can nest it; never persisted on the row. */
  piClaudeChildParent?: {
    runId: string
    providerSession: string
    transcriptPath: string
  }
  /** Session identity update with no turn-state transition; refreshes durable resume metadata without a fake status row. */
  providerSessionOnly?: boolean
  /** True when this event is a relay cache replay rather than a live hook. */
  isReplay?: boolean
  /** Execution host mints this end time; relays forward and result retries restate it. */
  turnEndedAt?: number
  /** How the host identified that end (agent-hook-turn-end-timing.ts); forwarded and restated with it. */
  turnEndDisposition?: TurnEndDisposition
  /** Verified stop_hook_active reentry after a blocking Stop hook; in-process only. */
  stopHookActive?: true
  /** Provider turn identity folded into hostTurn; never stored or sent directly. */
  nativeTurnKey?: string
  /** Saved host-private turn record; snapshot/IPC/relay allow-lists exclude it. */
  hostTurn?: HostTurnRecord
  /** Claude live work the child list does not show (a shell, a cron, an owed task notification); rejects false input-based interrupts. */
  claudeRunningNonAgentTask?: boolean
  /** Host-held structured session: owned while its provider child runs here, held afterward. Never persisted. */
  structuredHost?: StructuredHostStatus
  /** Rejoin moved pane rows by runtime terminal handle; never persist beyond its issuing runtime. */
  terminalHandle?: string
  /** Execution-host clock retained for age-preserving projection replay; never sent verbatim. */
  hostEvidenceObservedAt?: number
  payload: ParsedAgentStatusPayload
}

export type StructuredHostStatus = 'held' | 'owned'
export type ToolSnapshot = {
  toolName?: string
  toolInput?: string
  /** Copilot-only: the pane's LEAD session id, adopted at each turn boundary. A subagent's own
   *  hook events carry its own session id on the lead pane; comparing against this drops them. */
  leadSessionId?: string
  /** Full JSON of an AskUserQuestion tool input; set only on its own event and NOT inherited (resolveToolState) so no stale prompt lingers. */
  interactivePrompt?: string
  hasToolUpdate?: boolean
  hasToolInputField?: boolean
  lastAssistantMessage?: string
  /** Tool output remains visible in status cards but must not render as assistant prose in chat. */
  lastAssistantMessageIsToolOutput?: boolean
  clearLastAssistantMessage?: boolean
}
