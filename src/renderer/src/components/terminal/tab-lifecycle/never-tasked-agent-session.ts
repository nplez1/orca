import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'

/**
 * A known agent resting at the session boundary it started with: no turn, prompt, output, child
 * work or user input ever. Positive evidence only; any gap returns false so the close still asks.
 * A `done` that ended a real turn is a conversation, not empty (#95).
 */
export function isNeverTaskedAgentSession(args: {
  entry: AgentStatusEntry | undefined
  launchedPromptFree: boolean
  lastUserInputAt: number | undefined
}): boolean {
  const { entry } = args
  if (!args.launchedPromptFree || args.lastUserInputAt !== undefined || !entry) {
    return false
  }
  return (
    entry.agentType !== undefined &&
    entry.agentType !== 'unknown' &&
    entry.restoredUnconfirmed !== true &&
    entry.state === 'done' &&
    entry.sessionBoundary === true &&
    entry.stateHistory.length === 0 &&
    entry.turnStartedAt === undefined &&
    entry.turnEndedAt === undefined &&
    entry.prompt.trim() === '' &&
    !entry.lastAssistantMessage &&
    !entry.lastCompletedAssistantMessage &&
    !entry.interactivePrompt &&
    !entry.toolName &&
    !entry.subagents?.length &&
    !entry.children?.length &&
    entry.orchestration === undefined &&
    entry.paneSleep === undefined &&
    (entry.mainAgent === undefined ||
      (entry.mainAgent.state === 'done' && entry.mainAgent.outcome === undefined))
  )
}
