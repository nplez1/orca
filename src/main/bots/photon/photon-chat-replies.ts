// Where the channel meets a finished turn. Both ends of this are upstream-owned files, so the whole of it
// lives here and each of them gains one call: the wiring hands the reader over, and this decides whether
// the chat is one the channel opened, reads that turn's own answer, and sends it.
import type { Bot } from '../../../shared/bot-types'
import type { TurnEndedRows } from '../../native-chat/agent-session-wire/structured-agent-session-turn-context'
import { botOfSession } from '../bot-session-tabs'
import { photonServiceOf } from './photon-runtime'

export type PhotonChatReplyHost = {
  bots: Parameters<typeof botOfSession>[0]
}

/** Reads the finished turn and sends its answer to the conversation that asked, if this chat is one the
 *  channel opened. A bot's ordinary chats post nowhere and cost no journal read, and a turn with no
 *  answer sends nothing. */
export function photonChatTurnEnded(
  host: PhotonChatReplyHost,
  turn: {
    sessionId: string
    turnId: string
    readItems: (since: number | null) => Promise<TurnEndedRows>
  }
): void {
  const { sessionId, turnId, readItems } = turn
  const channel = photonServiceOf(host)
  const bot: Bot | null = botOfSession(host.bots, sessionId)
  if (!channel || !bot) {
    return
  }
  // Checked before the read, not after: every bot turn on the host comes through here, and a journal
  // read it cannot use is a cost paid by chats this channel never opened.
  if (!channel.answersChat(bot.id, sessionId)) {
    return
  }
  void readItems(null)
    .then((rows) => channel.sendChatTurnResult({ botId: bot.id, chatId: sessionId, turnId, rows }))
    .catch((error: unknown) =>
      console.warn('[photon] could not send a finished turn’s answer', error)
    )
}
