// The bot's answer going back to the conversation that asked. One send per finished turn, never one per
// agent event or progress tick — twenty messages per turn is a worse experience than one, and that is a
// rule about shape rather than a quota, since Beta charges nothing per iMessage send. A send is only ever
// addressed to a conversation Orca already has: inbound opens every conversation, so a cold start is a
// bug, not a feature.
import { createHash } from 'node:crypto'
import type { PhotonApi, PhotonCredential } from './photon-api'
import type { PhotonOutbox, PhotonOutboxEntry } from './photon-outbox'
import type { PhotonThreadMap } from './photon-thread-map'

/** Inline text this long is sent as it is; longer output is truncated with a note rather than pretending
 *  an attachment was uploaded. */
export const PHOTON_INLINE_TEXT_MAX = 3_000

export type PhotonTurnPayload = { kind: 'text'; body: string; truncated: boolean }

/**
 * Folds a finished turn's final message into exactly one thing to send. Beta publishes no attachment or
 * length limit, and nothing here uploads a file, so a long answer is sent as its opening plus a line
 * saying it was cut and where the whole of it is. Saying "the full answer is in the attached file" when
 * no file is attached was the lie; this says what actually happened.
 */
export function foldTurnResult(
  text: string,
  options: { inlineMax?: number } = {}
): PhotonTurnPayload {
  const trimmed = text.trim()
  const inlineMax = options.inlineMax ?? PHOTON_INLINE_TEXT_MAX
  if (trimmed.length <= inlineMax) {
    return { kind: 'text', body: trimmed, truncated: false }
  }
  return {
    kind: 'text',
    body: `${trimmed.slice(0, inlineMax).trimEnd()}\n\n[cut here: this answer is longer than one iMessage. The whole of it is in Orca.]`,
    truncated: true
  }
}

/**
 * The one thing a finished turn sends: its last assistant message, scoped to that turn. Progress items,
 * tool calls and status lines are not messages, so a turn that emitted twenty of them still sends once.
 */
export function turnResultText(items: readonly { role: string; text: string }[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.role === 'assistant' && item.text.trim().length > 0) {
      return item.text.trim()
    }
  }
  return null
}

export type PhotonSendDeps = {
  api: PhotonApi
  outbox: PhotonOutbox
  threads: PhotonThreadMap
  log?: (message: string, ...rest: unknown[]) => void
}

export type PhotonSendOutcome =
  | { sent: true; entryId: string; truncated: boolean }
  | { sent: false; entryId: string; error: string }

/** Why a send was refused before it was ever attempted. */
export class PhotonColdStartError extends Error {
  constructor(conversationId: string) {
    super(
      `Refusing to send to Photon conversation ${conversationId}: Orca has never answered it, and Orca never cold-starts a conversation.`
    )
    this.name = 'PhotonColdStartError'
  }
}

export class PhotonSendPath {
  private readonly log: (message: string, ...rest: unknown[]) => void

  constructor(private readonly deps: PhotonSendDeps) {
    this.log = deps.log ?? ((message, ...rest) => console.warn(message, ...rest))
  }

  /**
   * Records the turn's answer and tries to send it. The record is durable before the attempt, so a
   * failure leaves the result retriable instead of vanishing; `retryPending` is what picks it back up.
   */
  async sendTurnResult(input: {
    botId: string
    projectId: string
    conversationId: string
    credential: PhotonCredential
    text: string
    /** The turn this answer belongs to. The send is keyed on it rather than on the text, so two
     *  identical answers in one thread are two messages instead of one replayed idempotency key. */
    turnId: string
  }): Promise<PhotonSendOutcome> {
    if (!this.deps.threads.knows(input.botId, input.conversationId)) {
      throw new PhotonColdStartError(input.conversationId)
    }
    const payload = foldTurnResult(input.text)
    const entry = this.deps.outbox.enqueue({
      id: sendId(input.botId, input.conversationId, input.turnId),
      botId: input.botId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      body: payload.body,
      truncated: payload.truncated
    })
    return this.attempt(entry, input.credential)
  }

  /** Retries everything waiting for one bot. A send that lands is forgotten; one that fails is kept. */
  async retryPending(botId: string, credential: PhotonCredential): Promise<PhotonSendOutcome[]> {
    const outcomes: PhotonSendOutcome[] = []
    for (const entry of this.deps.outbox.pendingFor(botId)) {
      outcomes.push(await this.attempt(entry, credential))
    }
    return outcomes
  }

  private async attempt(
    entry: PhotonOutboxEntry,
    credential: PhotonCredential
  ): Promise<PhotonSendOutcome> {
    try {
      await this.deps.api.sendMessage({
        credential,
        projectId: entry.projectId,
        conversationId: entry.conversationId,
        text: entry.body,
        // Derived from the entry, so a retry of a send that may already have landed replays rather
        // than arriving twice.
        idempotencyKey: `photon-send-${entry.id}`
      })
      this.deps.outbox.settle(entry.id)
      return { sent: true, entryId: entry.id, truncated: entry.truncated }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.outbox.fail(entry.id, message)
      this.log('[photon] could not send a turn result; it is kept for a retry', message)
      return { sent: false, entryId: entry.id, error: message }
    }
  }
}

/** One id per (bot, conversation, turn), so a replayed turn end enqueues rather than duplicating while
 *  two turns with the same words are still two messages. */
function sendId(botId: string, conversationId: string, turnId: string): string {
  return createHash('sha256')
    .update(`${botId}\u0000${conversationId}\u0000${turnId}`)
    .digest('hex')
    .slice(0, 24)
}
