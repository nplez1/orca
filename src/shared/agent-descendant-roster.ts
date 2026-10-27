import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  type AgentStatusState,
  type AgentSubagentSnapshot
} from './agent-status-types'
import { normalizeOptionalField } from './agent-status-field-normalization'

/** Live descendants (subagents, spawned threads, async child runs) of one pane's
 *  lead agent session, keyed by the provider-assigned child id.
 *
 *  Provider-agnostic on purpose: the pane rule "idle only when the lead is idle
 *  AND no descendant is live" is one concept, so it has one implementation. A
 *  provider contributes only how to READ a child out of its hook events
 *  (`agent-hook-listener/descendant-events.ts`). Claude keeps its own roster
 *  because its children carry provider-specific reconciliation (teammate
 *  parking, `background_tasks` folding, restored-snapshot provenance) that no
 *  other provider has; it implements the same pane rule in
 *  `providers/claude-roster-state.ts`. */

const AGENT_DESCENDANT_ID_MAX_LENGTH = 64

export type AgentDescendantRoster = Map<string, TrackedAgentDescendant>

type TrackedAgentDescendant = {
  agentType?: string
  description?: string
  model?: string
  /** The tool this child is running now. Absent once it has none, or when its lane names only
   *  its lifecycle. */
  toolName?: string
  toolInput?: string
  /** The child's own provider conversation, when it runs as a separate agent process. */
  providerSession?: string
  state: 'working' | 'waiting'
  startedAt: number
  /** When this child was last named by one of its provider's events. The reaper's clock:
   *  a roster entry can only ever hold a pane 'working', so a claim nothing can retract
   *  is strictly worse than settling late. */
  lastEventAt: number
}

/** How long a descendant may go unmentioned before the pane stops believing in it.
 *
 *  Every provider loses a child's finish sometimes — the hook was disabled, untrusted or
 *  timed out, the process was killed, the turn was interrupted before its stop gate ran.
 *  Without a ceiling that pane is pinned 'working' for the life of the process, and only
 *  closing it recovers. Deliberately generous: a wrongly reaped child merely settles the
 *  pane early, which the lead's next event corrects, while too short a window would
 *  reintroduce the very bug this roster exists to fix. */
export const AGENT_DESCENDANT_QUIET_REAP_MS = 30 * 60_000

export function upsertAgentDescendant(
  roster: AgentDescendantRoster,
  id: string,
  fields: {
    agentType?: string
    description?: string
    model?: string
    toolName?: string
    toolInput?: string
    /** The child's tool call ended: drop the tool line rather than leaving the last one standing. */
    clearTool?: boolean
    providerSession?: string
    state: 'working' | 'waiting'
  },
  now: number
): void {
  const normalizedId = id.trim()
  if (normalizedId.length === 0 || normalizedId.length > AGENT_DESCENDANT_ID_MAX_LENGTH) {
    return
  }
  const agentType = normalizeOptionalField(fields.agentType, AGENT_TYPE_MAX_LENGTH)
  const description = normalizeOptionalField(fields.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  const model = normalizeOptionalField(fields.model, AGENT_MODEL_MAX_LENGTH)
  const toolName = normalizeOptionalField(fields.toolName, AGENT_TYPE_MAX_LENGTH)
  const toolInput = normalizeOptionalField(fields.toolInput, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  const providerSession = normalizeOptionalField(
    fields.providerSession,
    AGENT_DESCENDANT_ID_MAX_LENGTH
  )
  const existing = roster.get(normalizedId)
  if (existing) {
    existing.agentType = agentType ?? existing.agentType
    existing.description = description ?? existing.description
    existing.model = model ?? existing.model
    // Why merging, not replacing: the live-set path re-upserts every child from a payload that
    // names only its id, type and description, so a replacing write would erase the tool another
    // lane reported a moment earlier. Only an explicit clear drops it.
    if (fields.clearTool === true) {
      existing.toolName = undefined
      existing.toolInput = undefined
    } else {
      existing.toolName = toolName ?? existing.toolName
      existing.toolInput = toolInput ?? existing.toolInput
    }
    existing.providerSession = providerSession ?? existing.providerSession
    existing.state = fields.state
    existing.lastEventAt = now
    return
  }
  roster.set(normalizedId, {
    agentType,
    description,
    model,
    toolName,
    toolInput,
    providerSession,
    state: fields.state,
    startedAt: now,
    lastEventAt: now
  })
}

/** Replace the roster with the provider's authoritative live set. For a provider whose
 *  transport can drop an intermediate message this is the only safe shape: the newest
 *  message is complete, so it repairs every add and removal lost before it. */
export function replaceAgentDescendants(
  roster: AgentDescendantRoster,
  children: readonly {
    id: string
    agentType?: string
    description?: string
    model?: string
    providerSession?: string
  }[],
  now: number
): void {
  const live = new Set<string>()
  for (const child of children) {
    const normalizedId = child.id.trim()
    if (normalizedId.length === 0 || normalizedId.length > AGENT_DESCENDANT_ID_MAX_LENGTH) {
      continue
    }
    live.add(normalizedId)
    // Why: the live set is a liveness claim, not a state report. A child blocked on a human answer
    // is still live, and re-stamping it `working` from the parent's next post would drop the pane's
    // only actionable state until the child's own lane spoke again.
    const state = roster.get(normalizedId)?.state === 'waiting' ? 'waiting' : 'working'
    upsertAgentDescendant(roster, normalizedId, { ...child, state }, now)
  }
  for (const id of Array.from(roster.keys())) {
    if (!live.has(id)) {
      roster.delete(id)
    }
  }
}

/** Drop descendants no event has named for {@link AGENT_DESCENDANT_QUIET_REAP_MS}.
 *  Runs on read rather than on a timer so the roster stays passive. */
export function pruneStaleAgentDescendants(roster: AgentDescendantRoster, now: number): boolean {
  let changed = false
  for (const [id, tracked] of Array.from(roster.entries())) {
    if (now - tracked.lastEventAt > AGENT_DESCENDANT_QUIET_REAP_MS) {
      roster.delete(id)
      changed = true
    }
  }
  return changed
}

export function finishAgentDescendant(roster: AgentDescendantRoster, id: string): void {
  roster.delete(id.trim())
}

export function agentDescendantRosterToSnapshots(
  roster: AgentDescendantRoster | undefined
): AgentSubagentSnapshot[] | undefined {
  if (!roster || roster.size === 0) {
    return undefined
  }
  const snapshots = Array.from(roster, ([id, tracked]) => ({
    id,
    agentType: tracked.agentType,
    description: tracked.description,
    model: tracked.model,
    toolName: tracked.toolName,
    toolInput: tracked.toolInput,
    providerSession: tracked.providerSession,
    state: tracked.state,
    startedAt: tracked.startedAt
  }))
  snapshots.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  return snapshots
}

/** The live child whose OWN provider conversation this is, if the pane has one.
 *  A child that runs as a separate agent process (a `claude --print` a pi subagent started)
 *  reports its own hook stream on the pane it inherited, and its conversation id is the only
 *  thing that stream shares with the run that launched it. */
export function findAgentDescendantByProviderSession(
  roster: AgentDescendantRoster | undefined,
  providerSession: string | undefined
): { id: string; providerSession: string } | null {
  const wanted = providerSession?.trim()
  if (!roster || !wanted) {
    return null
  }
  for (const [id, tracked] of roster) {
    if (tracked.providerSession === wanted) {
      return { id, providerSession: wanted }
    }
  }
  return null
}

/** The pane's state once its live descendants are taken into account: a lead
 *  `done` is only the pane's `done` when nothing is still running under it. A
 *  descendant blocked on a human answer outranks the lead's own working state,
 *  since that wait is the actionable one. */
export function agentDescendantEffectiveState(
  roster: AgentDescendantRoster | undefined,
  leadState: AgentStatusState
): AgentStatusState {
  if (!roster || roster.size === 0) {
    return leadState
  }
  for (const tracked of roster.values()) {
    if (tracked.state === 'waiting') {
      return 'waiting'
    }
  }
  return leadState === 'done' ? 'working' : leadState
}
