// A run answering a local ask: its answer lands in the chat it was asked from, never in a Slack
// channel, Linear issue or thread this computer reaches only through Orca Cloud.
import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import { isQuietBotResult } from '../../shared/bot-quiet-result'
import { readBotConversationActsFor } from './bot-conversation-acts-for'
import type { BotRunDeliveryDependencies, BotRunResult } from './bot-run-results'
import { canonicalOrcaSessionId } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/** Whether a conversation's recorded askers are a person on this computer: a local ask. */
export function localAskAskers(actsFor: readonly BotRequestAsker[] | undefined): boolean {
  return actsFor?.some((asker) => asker.kind === 'person' && asker.source === 'local') ?? false
}

/** Whether this conversation was opened by a local ask, as Orca recorded it when it started. */
export function localAskConversation(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationDb' | 'listAutomationRuns' | 'showAutomation'>,
  sessionId: string
): boolean {
  const root = isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId
  return localAskAskers(readBotConversationActsFor(runtime, root)?.actsFor)
}

/**
 * The answer to a local ask, when the run's result would otherwise leave this computer: the chat it
 * was asked from gets it instead. Null when the result already lands there, or isn't one to send.
 */
export async function localAskAnswer(
  deps: Pick<BotRunDeliveryDependencies, 'localAskOf' | 'sendToChat'>,
  result: Pick<BotRunResult, 'sessionId' | 'automation' | 'bot' | 'target'>,
  message: string,
  from: AgentMessageSource
): Promise<{ error?: string } | null> {
  const { resultsTo } = result.target
  if (!message || isQuietBotResult(message) || resultsTo === 'none' || resultsTo === 'chat') {
    return null
  }
  if (deps.localAskOf?.(result.sessionId) !== true) {
    return null
  }
  try {
    await deps.sendToChat(result.bot, `Result of "${result.automation.name}":\n\n${message}`, from)
    return {}
  } catch (error) {
    console.warn('[bots] could not send a local ask its answer', error)
    return { error: "The answer couldn't be sent to the chat it was asked in." }
  }
}
