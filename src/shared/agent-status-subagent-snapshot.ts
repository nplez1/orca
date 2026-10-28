// Share hook-child snapshot normalization/equality so status stores can reuse unchanged arrays.

import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  normalizeOptionalField
} from './agent-status-field-normalization'

export type AgentSubagentState = 'working' | 'blocked' | 'waiting' | 'idle' | 'unverifiable'

/** Live in-process provider child shown as an indented row without its own PTY. */
export type AgentSubagentSnapshot = {
  /** Provider-assigned lifecycle id. */
  id: string
  agentType?: string
  /** Provider model used by this child, when exposed by its lifecycle event. */
  model?: string
  description?: string
  /** The tool this child is running now, as its own lane reported it. Absent for a child whose
   *  lane names only its lifecycle — every CLI child on the hook lane is one. */
  toolName?: string
  toolInput?: string
  /** The child's OWN provider conversation, when the child runs as a separate agent process
   *  (a `claude --print` started by a pi subagent). It is the only key that can join that
   *  process's hook stream back to this row. */
  providerSession?: string
  state: AgentSubagentState
  /** Timestamp (ms) when this subagent was first observed. */
  startedAt: number
}

export const AGENT_SUBAGENT_ID_MAX_LENGTH = 64

function normalizeSubagentSnapshot(
  value: unknown,
  allowFutureState: boolean
): AgentSubagentSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const obj = Object.fromEntries(Object.entries(value))
  if (typeof obj.id !== 'string') {
    return null
  }
  const id = obj.id.trim()
  if (id.length === 0 || id.length > AGENT_SUBAGENT_ID_MAX_LENGTH) {
    return null
  }
  const state = ['working', 'blocked', 'waiting', 'idle', 'unverifiable'] as const
  const knownState = state.find((candidate) => candidate === obj.state)
  if (!knownState && (!allowFutureState || typeof obj.state !== 'string')) {
    return null
  }
  return {
    id,
    state: knownState ?? 'unverifiable',
    startedAt:
      typeof obj.startedAt === 'number' && Number.isFinite(obj.startedAt) ? obj.startedAt : 0,
    agentType: normalizeOptionalField(obj.agentType, AGENT_TYPE_MAX_LENGTH),
    model: normalizeOptionalField(obj.model, AGENT_MODEL_MAX_LENGTH),
    description: normalizeOptionalField(obj.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH),
    toolName: normalizeOptionalField(obj.toolName, AGENT_TYPE_MAX_LENGTH),
    toolInput: normalizeOptionalField(obj.toolInput, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH),
    providerSession: normalizeOptionalField(obj.providerSession, AGENT_SUBAGENT_ID_MAX_LENGTH)
  }
}

export function normalizeAgentSubagentsField(value: unknown): AgentSubagentSnapshot[] | undefined {
  return readAgentSubagents(value, false)
}

/** Published snapshots tolerate future state words; producer admission remains strict. */
export function decodeAgentSubagentsField(value: unknown): AgentSubagentSnapshot[] | undefined {
  return readAgentSubagents(value, true)
}

function readAgentSubagents(
  value: unknown,
  allowFutureState: boolean
): AgentSubagentSnapshot[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined
  }
  const normalized: AgentSubagentSnapshot[] = []
  for (const item of value) {
    const snapshot = normalizeSubagentSnapshot(item, allowFutureState)
    if (snapshot) {
      normalized.push(snapshot)
    }
  }
  return normalized.length > 0 ? normalized : undefined
}

/** Reuse unchanged list references to skip store fanout. */
export function agentSubagentsEqual(
  a: AgentSubagentSnapshot[] | undefined,
  b: AgentSubagentSnapshot[] | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return !a && !b
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.state !== y.state ||
      x.startedAt !== y.startedAt ||
      x.agentType !== y.agentType ||
      x.model !== y.model ||
      x.description !== y.description ||
      x.toolName !== y.toolName ||
      x.toolInput !== y.toolInput ||
      x.providerSession !== y.providerSession
    ) {
      return false
    }
  }
  return true
}

/** The tool line a child's row shows for this snapshot, as `tool: input`, or undefined.
 *  Lives beside the fields it reads so a lane that starts publishing a tool cannot leave the row
 *  builder guessing which of the two shapes it meant. */
export function agentSubagentToolOperation(
  snapshot: Pick<AgentSubagentSnapshot, 'toolName' | 'toolInput'>
): { toolName: string; input?: string } | undefined {
  if (snapshot.toolName === undefined) {
    return undefined
  }
  return snapshot.toolInput !== undefined
    ? { toolName: snapshot.toolName, input: snapshot.toolInput }
    : { toolName: snapshot.toolName }
}
