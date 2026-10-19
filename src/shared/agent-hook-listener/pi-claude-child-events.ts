import {
  findAgentDescendantByProviderSession,
  pruneStaleAgentDescendants,
  type AgentDescendantRoster
} from '../agent-descendant-roster'
import { normalizeHookEventName } from './provider-event-names'
import { readFirstString } from './interactive-tool'
import { deriveFallbackToolInputPreview, deriveToolInputPreview } from './tool-input-preview'
import type { AgentHookSource } from '../agent-hook-relay'
import type { AgentProviderSessionMetadata } from '../agent-session-resume'
import { applyDescendantEventToPane, isRetiredPiClaudeChild } from './descendant-pane-state'
import { isNestedPiSessionEvent } from './nested-pi-session-guard'
import type { DescendantEventFacts } from './descendant-events'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'

/** A claude CLI child of a pi subagent run, as this pane's roster knows it. */
export type PiClaudeChildMatch = {
  /** The pi subagent run id, which is the child row's own id. */
  id: string
  /** The child's claude conversation. */
  providerSession: string
}

/**
 * The live child of this pane whose own provider conversation is `providerSession`.
 *
 * A pi subagent that runs an agent through the `claude` CLI spawns a separate process which
 * inherits the pane's `ORCA_*` environment and therefore posts its own hooks here under its own
 * `session_id`. That stream is the only place the child's live state, model and current tool
 * exist — but it is not the pane's own agent, and treating it as one would drive the parent's
 * turn. The conversation id is what joins the two: the plugin pins it with `--session-id` and
 * publishes it on `subagents:session` before the first hook fires.
 */
export function findPiClaudeChild(
  state: HookListenerState,
  paneKey: string,
  providerSession: string | undefined
): PiClaudeChildMatch | null {
  const roster: AgentDescendantRoster | undefined = state.descendantRosterByPaneKey.get(paneKey)
  const match = findAgentDescendantByProviderSession(roster, providerSession)
  return match ? { id: match.id, providerSession: match.providerSession } : null
}

/** Whether this pane holds a live child right now, on the reaper's clock.
 *
 *  Pruned first on purpose: a refused post is the one path that cannot refresh or empty the roster,
 *  so reading it unpruned would let a run whose end never arrived keep the pane fenced for good. */
function paneHoldsLiveDescendant(state: HookListenerState, paneKey: string): boolean {
  const roster = state.descendantRosterByPaneKey.get(paneKey)
  if (!roster) {
    return false
  }
  pruneStaleAgentDescendants(roster, Date.now())
  if (roster.size === 0) {
    state.descendantRosterByPaneKey.delete(paneKey)
    return false
  }
  return true
}

/** The two notification types claude sends when it is waiting for a person, not for the next turn. */
const BLOCKED_NOTIFICATION_TYPES = new Set(['permission_prompt', 'elicitation_dialog'])

function isBlockedNotificationType(hookPayload: Record<string, unknown>): boolean {
  const type = readFirstString(hookPayload, ['notification_type', 'notificationType'])
  return type !== undefined && BLOCKED_NOTIFICATION_TYPES.has(type)
}

/** Tool detail a claude child event carries, as `tool: input`. */
function readChildTool(hookPayload: Record<string, unknown>): {
  toolName?: string
  toolInput?: string
} {
  const toolName = readFirstString(hookPayload, ['tool_name', 'toolName', 'name'])
  const toolInput = hookPayload['tool_input'] ?? hookPayload['toolInput']
  const preview =
    deriveToolInputPreview(toolName, toolInput) ?? deriveFallbackToolInputPreview(toolInput)
  return {
    ...(toolName !== undefined ? { toolName } : {}),
    ...(preview !== undefined ? { toolInput: preview } : {})
  }
}

/**
 * Read one event of a claude child's own hook stream as a descendant fact for its row.
 *
 * The child's lifecycle is not the pane's: nothing here can settle the parent or fire its
 * completion, and a `Stop` only means the child's turn ended — the run itself ends when the pi
 * lane retires it. `SessionEnd` is the one event that finishes the row, because that process is
 * gone and no further event of its stream can arrive.
 */
export function readPiClaudeChildEvent(
  match: PiClaudeChildMatch,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): DescendantEventFacts {
  const event = normalizeHookEventName(eventName)
  // Why not `ended`: that process exiting is not the RUN ending, and the runner session that
  // started it is still wrapping up. Dropping the row here would empty the pane's roster, which is
  // what tells a second session apart from the pane's own — so the runner's last posts would be
  // adopted and flip the pane's resume identity. The child's liveness is pi's to retire; this only
  // clears the tool line it can no longer be running.
  if (event === 'session_end') {
    return {
      kind: 'child',
      id: match.id,
      providerSession: match.providerSession,
      ended: false,
      toolEnded: true
    }
  }
  if (event === 'pre_tool_use') {
    return {
      kind: 'child',
      id: match.id,
      providerSession: match.providerSession,
      ended: false,
      ...readChildTool(hookPayload)
    }
  }
  if (event === 'post_tool_use' || event === 'post_tool_use_failure') {
    return {
      kind: 'child',
      id: match.id,
      providerSession: match.providerSession,
      ended: false,
      toolEnded: true
    }
  }
  // Why only these two types: the child's lane reads a wait as the pane's actionable state, and
  // claude emits an `idle_prompt` notification routinely — taking every notification as a wait
  // would park the row on one until the child's next event, which the live set now preserves.
  if (event === 'notification' && isBlockedNotificationType(hookPayload)) {
    return {
      kind: 'child',
      id: match.id,
      providerSession: match.providerSession,
      ended: false,
      waiting: true
    }
  }
  return {
    kind: 'child',
    id: match.id,
    providerSession: match.providerSession,
    ended: false
  }
}

/**
 * Build the envelope for one event of a claude CLI child's own hook stream.
 *
 * Deliberately its own envelope rather than the pane's: the child process is not the row's owner,
 * so no `agentPresence` rides along; its conversation is not the pane's resume target, so the row
 * keeps the owner session it already had — which is also what the nested-session fence compares
 * against. What the event DOES carry is the child's row state, the tool it is on, and the one
 * durable fact a session-list scan cannot otherwise learn: which pi session spawned it.
 */
export function buildPiClaudeChildEvent(args: {
  state: HookListenerState
  source: AgentHookSource
  paneKey: string
  tabId?: string
  worktreeId?: string
  launchToken?: string
  match: PiClaudeChildMatch
  eventName: unknown
  hookPayload: Record<string, unknown>
  /** Where the child's conversation is written, when the post named it. */
  transcriptPath?: string
  /** The pi session that owns the pane, kept so the row never loses its owner. */
  ownerSession?: AgentProviderSessionMetadata
  /** The provider that owns the pane. The child's own source would drive the parent's turn. */
  paneSource: AgentHookSource
}): AgentHookEventPayload | null {
  const payload = applyDescendantEventToPane(
    args.state,
    args.source,
    args.paneKey,
    readPiClaudeChildEvent(args.match, args.eventName, args.hookPayload)
  )
  if (!payload) {
    return null
  }
  return {
    paneKey: args.paneKey,
    // Why the pane's source and no hook event name: the server reads a turn edge out of
    // `isNewTurnEvent(source, hookEventName)`, and the child's own `SessionStart` /
    // `UserPromptSubmit` would otherwise reset the pane's turn clock, clear an acknowledged
    // attention badge and re-open manual unread. `toolAgentId` is the child marker that path
    // already honours, and it keeps the pane's own tool line and prompt cache out of this.
    source: args.paneSource,
    toolAgentId: args.match.id,
    launchToken: args.launchToken,
    tabId: args.tabId,
    worktreeId: args.worktreeId,
    connectionId: null,
    ...(args.ownerSession ? { providerSession: args.ownerSession } : {}),
    // Why only with a path: that path is where the parent link is recorded for the session list,
    // and a placeholder would name a file that does not exist.
    ...(args.transcriptPath
      ? {
          piClaudeChildParent: {
            runId: args.match.id,
            providerSession: args.match.providerSession,
            transcriptPath: args.transcriptPath
          }
        }
      : {}),
    payload
  }
}

/** What the caller should do with a post that arrived on a pane with a nested agent. */
export type PiClaudeChildAdmission =
  /** Nothing nested claimed it: the pane's own path applies, unchanged. */
  | { kind: 'pass' }
  /** A second session of the pane's process, while this pane still holds a live child run: the
   *  post describes that child's runner, not the pane, so nothing on it may be published. */
  | { kind: 'refuse' }
  /** It belongs to a claude CLI child of the pane's pi subagent run: publish this, and nothing else. */
  | { kind: 'child'; event: AgentHookEventPayload | null }

/**
 * Decide one post against the two nested agents a pane can host: a pi session nested inside the
 * pane's own (a claude child's runner), and the claude CLI child those two collaborated to start.
 *
 * The order matters. A pi runner session is refused before anything reads its child set, because
 * that set is empty and a pi post replaces the roster with it. A claude child then gets its own
 * envelope, because claude's lane would otherwise read the child's `SessionEnd` as the pane's
 * process exiting, its prompt as the pane's turn, and its stop as the pane's completion. Only a
 * post neither of them claims keeps the pane's ordinary path — including the inherited-owner guard,
 * which must not see the child's stream at all.
 */
export function admitNestedAgentPost(args: {
  state: HookListenerState
  source: AgentHookSource
  paneKey: string
  eventName: unknown
  hookPayload: Record<string, unknown>
  providerSession: AgentProviderSessionMetadata | null
  previousStatus: Pick<AgentHookEventPayload, 'providerSession'> | undefined
  /** The provider that owns the pane, which the child's posts must report as. */
  paneSource: AgentHookSource
  coords: { tabId?: string; worktreeId?: string; launchToken?: string }
}): PiClaudeChildAdmission {
  // Why the liveness gate: a runner session exists only while a child of this pane runs, so a live
  // roster is what makes a second session recognisable as that runner. Refusing on the session id
  // alone would be permanent — pi's latest-only queue can drop the `session_start` that hands the
  // pane over, and this branch never updates the id it compares against.
  if (
    paneHoldsLiveDescendant(args.state, args.paneKey) &&
    isNestedPiSessionEvent({
      previousStatus: args.previousStatus,
      source: args.source,
      providerSession: args.providerSession,
      eventName: args.eventName
    })
  ) {
    return { kind: 'refuse' }
  }
  const match =
    args.source === 'claude'
      ? findPiClaudeChild(args.state, args.paneKey, args.providerSession?.id)
      : null
  if (!match) {
    // Why: a child's own process can outlive its row — a hook spooled before the retirement, or a
    // retirement that beat the process — and its stream would then be read as the pane's own agent,
    // ending the parent's presence or relabelling its row. Its conversation says it is still a child.
    return args.source === 'claude' &&
      isRetiredPiClaudeChild(args.state, args.paneKey, args.providerSession?.id)
      ? { kind: 'refuse' }
      : { kind: 'pass' }
  }
  return {
    kind: 'child',
    event: buildPiClaudeChildEvent({
      state: args.state,
      source: args.source,
      paneKey: args.paneKey,
      tabId: args.coords.tabId,
      worktreeId: args.coords.worktreeId,
      launchToken: args.coords.launchToken,
      match,
      eventName: args.eventName,
      hookPayload: args.hookPayload,
      transcriptPath: args.providerSession?.transcriptPath,
      ownerSession: args.previousStatus?.providerSession,
      paneSource: args.paneSource
    })
  }
}
