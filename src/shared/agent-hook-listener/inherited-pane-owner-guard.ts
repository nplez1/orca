import type { AgentProcessIdentity } from '../agent-process-presence'
import type { AgentType } from '../agent-status-types'
import type { AgentHookEventPayload } from './listener-event'
import { resolveAgentStatusIdentity } from '../agent-status-identity'
import { sameAgentStatusTerminalOwner } from '../agent-status-terminal-owner'

/**
 * Whether an incoming hook event belongs to an agent that inherited this pane from another one
 * still running in it. Split out of agent-hook-listener.ts, which sits on the max-lines budget.
 */
export function isInheritedPaneOwnerEvent(args: {
  previousStatus: AgentHookEventPayload | undefined
  worktreeId: string | undefined
  source: AgentType
  incomingProcess?: AgentProcessIdentity
}): boolean {
  const { previousStatus, worktreeId, source, incomingProcess } = args
  const previousReceivedAt =
    previousStatus &&
    'receivedAt' in previousStatus &&
    typeof previousStatus.receivedAt === 'number'
      ? previousStatus.receivedAt
      : previousStatus?.hostEvidenceObservedAt
  if (
    !previousStatus ||
    previousReceivedAt === undefined ||
    !sameAgentStatusTerminalOwner(
      { connectionId: previousStatus.connectionId ?? null, worktreeId: previousStatus.worktreeId },
      { connectionId: null, worktreeId }
    )
  ) {
    return false
  }
  return resolveAgentStatusIdentity({
    existing: {
      agentType: previousStatus.payload.agentType,
      state: previousStatus.payload.state,
      updatedAt: previousReceivedAt,
      restoredUnconfirmed: previousStatus.restoredUnconfirmed,
      agentPresence: previousStatus.providerSessionOnly ? undefined : previousStatus.agentPresence
    },
    incoming: source,
    incomingProcess,
    now: Date.now()
  }).inheritedFromActivePane
}
