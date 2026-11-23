// A finished turn's answer going back to the person who texted it. Wired where a bot session's turn
// ends, so it happens once per turn rather than once per agent event: the journal is read for that one
// turn's last assistant message, and everything else about the turn — progress items, tool calls,
// status lines — is not something to send. Nothing runs unless the chat is one this channel opened, so a
// bot's ordinary chats never post anywhere.
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentSessionTurnAssistantMessage } from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { TurnEndedRows } from '../../native-chat/agent-session-wire/structured-agent-session-turn-context'
import type { PhotonThreadMap } from './photon-thread-map'

/** The turn's own item id, which is what scopes an assistant message to it. */
function turnItemIdOf(rows: TurnEndedRows): string | null {
  for (let index = rows.items.length - 1; index >= 0; index -= 1) {
    const item = rows.items[index]
    if (item && readAgentJournalTurn(item.body) !== null) {
      return item.itemId
    }
  }
  return null
}

/**
 * The one message a finished turn sends, or null when there is nothing to send. Scoped to `turnId` when
 * one is given, so a second turn that has already started cannot make the first answer read from it.
 */
export function photonTurnResultText(rows: TurnEndedRows, turnId?: string): string | null {
  const turnItemId = turnItemIdOf(rows)
  if (!turnItemId) {
    return null
  }
  if (turnId !== undefined) {
    const own = rows.items.find((item) => item.itemId === turnItemId)
    const held = own ? readAgentJournalTurn(own.body) : null
    if (held !== null && held.turnId !== turnId) {
      // The journal's newest turn is not the one that ended, which happens when a queued message has
      // already started. Its prose is not this turn's answer, so nothing is sent rather than the
      // wrong turn's words.
      return null
    }
  }
  const prose = structuredAgentSessionTurnAssistantMessage(rows.items, turnItemId).trim()
  return prose.length > 0 ? prose : null
}

/** The conversation this chat answers, or null when the chat is not one this channel opened. */
export function photonConversationOfChat(
  threads: PhotonThreadMap,
  botId: string,
  chatId: string
): Promise<string | null> {
  return threads.conversationFor(botId, chatId)
}
