// The bot's answer going back to the conversation that asked. One send per finished turn, never one per
// agent event or progress tick — twenty messages per turn is a worse experience than one, and that is a
// rule about shape rather than a quota, since Beta charges nothing per iMessage send. Long output is one
// attachment rather than N messages. And a send is only ever addressed to a conversation Orca already
// has: inbound opens every conversation, so a cold start is a bug, not a feature.
import { createHash } from 'node:crypto'
import type { PhotonApi, PhotonCredential } from './photon-api'
import type { PhotonOutbox, PhotonOutboxEntry } from './photon-outbox'
import type { PhotonThreadMap } from './photon-thread-map'

/** Inline text this long is sent as it is; longer output folds into one attachment instead. */
export const PHOTON_INLINE_TEXT_MAX = 3_000

export type PhotonTurnPayload =
  | { kind: 'text'; body: string }
  | { kind: 'attachment'; body: string; attachment: { filename: string; content: string } }

/**
 * Folds a finished turn's final message into exactly one thing to send. A long answer becomes one
 * attachment with a short caption, not a split across several messages — the rule is about the number
 * of sends, so folding here is what enforces it.
 */
export function foldTurnResult(
  text: string,
  options: { botName?: string; inlineMax?: number } = {}
): PhotonTurnPayload {
  const trimmed = text.trim()
  const inlineMax = options.inlineMax ?? PHOTON_INLINE_TEXT_MAX
  if (trimmed.length <= inlineMax) {
    return { kind: 'text', body: trimmed }
  }
  const name = (options.botName ?? 'bot').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()
  const stamp = createHash('sha256').update(trimmed).digest('hex').slice(0, 8)
  return {
    kind: 'attachment',
    body: `${trimmed.slice(0, 280).trimEnd()}… (the full answer is in the attached file)`,
    attachment: { filename: `${name}-answer-${stamp}.md`, content: trimmed }
  }
}

/**
 * The one thing a finished turn sends: its last assistant message. Progress items, tool calls and
 * status lines are not messages, so a turn that emitted twenty of them still sends once — the quota
 * rule is about the shape of the answer, not a counter that has to be remembered.
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
  /** Uploads an attachment and returns the text that names it. Absent in v1: Photon's attachment and
   *  length limits are unpublished, so a long answer is capped into one message instead of pretending
   *  an upload works. The fold still returns one attachment, which is the shape a sender will use. */
  uploadAttachment?: (input: {
    botId: string
    projectId: string
    credential: PhotonCredential
    filename: string
    content: string
  }) => Promise<string>
}

export type PhotonSendOutcome =
  | { sent: true; entryId: string; kind: PhotonTurnPayload['kind'] }
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
    botName?: string
    projectId: string
    conversationId: string
    credential: PhotonCredential
    text: string
  }): Promise<PhotonSendOutcome> {
    if (!this.deps.threads.knows(input.botId, input.conversationId)) {
      throw new PhotonColdStartError(input.conversationId)
    }
    const payload = foldTurnResult(input.text, { botName: input.botName })
    const entry = this.deps.outbox.enqueue({
      id: sendId(input.botId, input.conversationId, payload),
      botId: input.botId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      body: payload.body
    })
    return this.attempt(entry, input.credential, payload)
  }

  /** Retries everything waiting for one bot. A send that lands is forgotten; one that fails is kept. */
  async retryPending(botId: string, credential: PhotonCredential): Promise<PhotonSendOutcome[]> {
    const outcomes: PhotonSendOutcome[] = []
    for (const entry of this.deps.outbox.pendingFor(botId)) {
      outcomes.push(await this.attempt(entry, credential, { kind: 'text', body: entry.body }))
    }
    return outcomes
  }

  private async attempt(
    entry: PhotonOutboxEntry,
    credential: PhotonCredential,
    payload: PhotonTurnPayload
  ): Promise<PhotonSendOutcome> {
    try {
      let body = payload.body
      if (payload.kind === 'attachment' && this.deps.uploadAttachment) {
        const caption = await this.deps.uploadAttachment({
          botId: entry.botId,
          projectId: entry.projectId,
          credential,
          filename: payload.attachment.filename,
          content: payload.attachment.content
        })
        body = `${body}\n\n${caption}`
      }
      await this.deps.api.sendMessage({
        credential,
        projectId: entry.projectId,
        conversationId: entry.conversationId,
        text: body,
        // Derived from the entry, so a retry of a send that may already have landed replays rather
        // than arriving twice.
        idempotencyKey: `photon-send-${entry.id}`
      })
      this.deps.outbox.settle(entry.id)
      return { sent: true, entryId: entry.id, kind: payload.kind }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.outbox.fail(entry.id, message)
      this.log('[photon] could not send a turn result; it is kept for a retry', message)
      return { sent: false, entryId: entry.id, error: message }
    }
  }
}

/** One id per (bot, conversation, answer), so a replayed turn end enqueues rather than duplicating. */
function sendId(botId: string, conversationId: string, payload: PhotonTurnPayload): string {
  return createHash('sha256')
    .update(`${botId}\u0000${conversationId}\u0000${payload.body}`)
    .digest('hex')
    .slice(0, 24)
}
