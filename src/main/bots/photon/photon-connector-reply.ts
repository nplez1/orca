// A reply into the iMessage thread that woke a bot (`orca bot reply`, `connector.reply`).
//
// Why this exists as its own module: that RPC is cloud-shaped end to end — it resolves a cloud
// conversation from the seam and asks Orca Cloud to post — so the one conversational channel the fork
// owns refused its own threads as `not_a_cloud_conversation`. There is no cloud in the middle here, so
// the post goes through the channel's own outbox, which is durable and retried.
//
// The channel and the bot are handed in rather than looked up: the caller has the runtime, and a lookup
// buried here would make the one decision worth testing reachable only through module-level wiring.
import type { PhotonSendOutcome } from './photon-send'

/** Where a reply landed, in the shape `connector.reply` returns and the CLI prints. */
export type PhotonConnectorReplyOutcome = {
  status: 'posted' | 'queued'
  place: string
  notices?: string[]
}

/** A verb this thread cannot take. Thrown with the code `connector.reply` reports and the CLI explains. */
export class PhotonReplyRefusal extends Error {
  constructor(readonly code: 'no_review_on_imessage') {
    super(code)
    this.name = 'PhotonReplyRefusal'
  }
}

/** The two methods this needs from the channel, so a test can hand it a fake. */
export type PhotonReplyChannel = {
  conversationForChat: (botId: string, chatId: string) => Promise<string | null>
  sendTurnResult: (input: {
    botId: string
    conversationId: string
    text: string
    turnId: string
  }) => Promise<PhotonSendOutcome>
}

const PLACE = 'the iMessage conversation'

/**
 * Posts `text` into the conversation this chat answers, or returns null when this is not one of the
 * channel's chats — the caller then takes its cloud path, unchanged.
 *
 * `replyId` keys the send, so a retried call is one message rather than two. `review` is refused
 * rather than ignored: an approval is a verdict, and dropping it while posting the prose would report
 * a review that never happened.
 */
export async function postPhotonReply(
  channel: PhotonReplyChannel | null,
  input: { botId: string; chatId: string; text: string; replyId: string; review?: unknown }
): Promise<PhotonConnectorReplyOutcome | null> {
  if (!channel) {
    return null
  }
  if (input.review) {
    throw new PhotonReplyRefusal('no_review_on_imessage')
  }
  const conversationId = await channel.conversationForChat(input.botId, input.chatId)
  if (!conversationId) {
    return null
  }
  const outcome = await channel.sendTurnResult({
    botId: input.botId,
    conversationId,
    text: input.text,
    turnId: input.replyId
  })
  return outcome.sent
    ? { status: 'posted', place: PLACE }
    : {
        status: 'queued',
        place: PLACE,
        notices: [`Photon did not take it yet (${outcome.error}); it stays queued and retries.`]
      }
}
