import type {
  AgentStatusMetadata,
  AgentStatusPayload
} from '../../store/slices/agent-status-contract'
import {
  normalizeAgentStatusPayload,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'

export function normalizeAgentStatusEvent(
  data: AgentStatusIpcPayload
): ParsedAgentStatusPayload | null {
  return normalizeAgentStatusPayload({
    state: data.state,
    workingMode: data.workingMode,
    prompt: data.prompt,
    agentType: data.agentType,
    model: data.model,
    toolName: data.toolName,
    toolInput: data.toolInput,
    interactivePrompt: data.interactivePrompt,
    lastAssistantMessage: data.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: data.lastAssistantMessageIsToolOutput,
    interrupted: data.interrupted,
    sessionBoundary: data.sessionBoundary,
    turnCompletedAt: data.turnCompletedAt,
    subagents: data.subagents
  })
}

export function normalizeAgentStatusMetadata(
  data: AgentStatusIpcPayload,
  authorityRestartId?: string
): AgentStatusMetadata | undefined {
  if (!data.providerSession && !data.launchToken && !authorityRestartId) {
    return undefined
  }
  return {
    ...(authorityRestartId ? { authorityRestartId } : {}),
    ...(data.providerSession ? { providerSession: data.providerSession } : {}),
    ...(data.launchToken ? { launchToken: data.launchToken } : {})
  }
}

/**
 * Fold the fields the IPC envelope carries — turn boundary, restored marker and
 * observation provenance — onto an already-resolved status payload.
 *
 * Order is load-bearing only in that each field is optional; a field absent from
 * the envelope leaves the payload untouched rather than clearing it.
 */
export function withAgentStatusEnvelopeFields(
  payload: AgentStatusPayload,
  data: AgentStatusIpcPayload
): AgentStatusPayload {
  const withTurnBoundary = data.promptInteractionKey
    ? { ...payload, promptInteractionKey: data.promptInteractionKey }
    : payload
  const withRestored =
    data.restoredUnconfirmed === true
      ? { ...withTurnBoundary, restoredUnconfirmed: true }
      : withTurnBoundary
  return data.observation ? { ...withRestored, observation: data.observation } : withRestored
}
