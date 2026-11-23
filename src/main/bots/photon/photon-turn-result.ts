// A finished turn's answer going back to the person who texted it. Wired where a bot session's turn
// ends, so it happens once per turn rather than once per agent event: the journal is read for that one
// turn's last assistant message, and everything else about the turn — progress items, tool calls,
// status lines — is not something to send. Nothing runs unless the chat is one this channel opened, so a
// bot's ordinary chats never post anywhere.
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentSessionTurnAssistantMessage } from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { TurnEndedRows } from '../../native-chat/agent-session-wire/structured-agent-session-turn-context'
import type { PhotonThreadMap } from './photon-thread-map'

/** Turn records in the rows, oldest first, as `[itemId, turnId]`. */
function turnRecordsOf(rows: TurnEndedRows): { itemId: string; turnId: string }[] {
  const records: { itemId: string; turnId: string }[] = []
  for (const item of rows.items) {
    const held = item ? readAgentJournalTurn(item.body) : null
    if (item && held) {
      records.push({ itemId: item.itemId, turnId: held.turnId })
    }
  }
  return records
}

/**
 * The one message a finished turn sends, or null when there is nothing to send.
 *
 * The turn's record is **selected by `turnId`**, not taken as the newest one. Deliveries queue, so a
 * second text can start turn 2 and write its record before turn 1's rows are read — and this read
 * happens behind an `await` — which makes "newest" the wrong turn often enough to matter. Reading the
 * newest and then refusing when it is not ours would drop the first turn's answer entirely.
 *
 * Without a `turnId` the newest record is the only thing to go on; that is the shape a caller with no
 * turn id has, not a guess this code makes for a caller that has one.
 */
export function photonTurnResultText(rows: TurnEndedRows, turnId?: string): string | null {
  const records = turnRecordsOf(rows)
  const mine =
    turnId === undefined ? records.at(-1) : records.find((entry) => entry.turnId === turnId)
  if (!mine) {
    return null
  }
  const prose = structuredAgentSessionTurnAssistantMessage(rows.items, mine.itemId).trim()
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
