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
  /**
   * Where this bot's text goes when it is not the HTTP client. An account-provisioned bot sends with its
   * project key; a bot on an existing Spectrum project sends through its own SDK, which has no key to
   * pass and is addressed by conversation id. Absent for the account path, so nothing about it changes.
   */
  transport?: (botId: string) => PhotonSendTransport | null
  log?: (message: string, ...rest: unknown[]) => void
  /** Reports an answer the retry horizon passed on, so it is visible rather than a console line. */
  noteUndelivered?: (botId: string, reason: string) => void | Promise<void>
}

/** One message handed to whichever transport a bot has: the conversation it belongs to, and its text. */
export type PhotonSendTransport = {
  send(conversationId: string, text: string): Promise<void>
}

export type PhotonSendOutcome =
  | { sent: true; entryId: string; truncated: boolean }
  // `settled`: the entry is no longer the outbox's, because a concurrent attempt sent or forgot it.
  | { sent: false; entryId: string; error: string; settled?: true }

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
   *
   * `credential` is what the HTTP client authenticates with, and a bot on an existing Spectrum project
   * has none: its channel is the transport, which is why the key is optional and the attempt says so.
   */
  async sendTurnResult(input: {
    botId: string
    projectId: string
    conversationId: string
    credential?: PhotonCredential
    text: string
    /** The turn this answer belongs to. The send is keyed on it rather than on the text, so two
     *  identical answers in one thread are two messages instead of one replayed idempotency key. */
    turnId: string
  }): Promise<PhotonSendOutcome> {
    if (!(await this.deps.threads.knows(input.botId, input.conversationId))) {
      throw new PhotonColdStartError(input.conversationId)
    }
    const payload = foldTurnResult(input.text)
    const entry = await this.deps.outbox.enqueue({
      id: sendId(input.botId, input.conversationId, input.turnId),
      botId: input.botId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      body: payload.body,
      truncated: payload.truncated
    })
    return this.attempt(entry, input.credential ?? null)
  }

  /** Retries everything waiting for one bot. A send that lands is forgotten; one that fails is kept. */
  async retryPending(
    botId: string,
    credential: PhotonCredential | null
  ): Promise<PhotonSendOutcome[]> {
    const outcomes: PhotonSendOutcome[] = []
    for (const entry of await this.deps.outbox.pendingFor(botId)) {
      outcomes.push(await this.attempt(entry, credential))
    }
    return outcomes
  }

  private async attempt(
    entry: PhotonOutboxEntry,
    credential: PhotonCredential | null
  ): Promise<PhotonSendOutcome> {
    try {
      await this.deliver(entry, credential)
      await this.deps.outbox.settle(entry.id)
      return { sent: true, entryId: entry.id, truncated: entry.truncated }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const outcome = await this.deps.outbox.fail(entry.id, message)
      if (outcome.kind === 'dropped') {
        // The horizon passed and *this* call ended it: the answer stops being retried, but it is recorded
        // as owed rather than dropped quietly.
        await this.deps.noteUndelivered?.(entry.botId, message)
        return { sent: false, entryId: entry.id, error: message }
      }
      if (outcome.kind === 'kept') {
        this.log('[photon] could not send a turn result; it is kept for a retry', message)
        return { sent: false, entryId: entry.id, error: message }
      }
      // `gone`: a concurrent attempt settled it, or the bot was released while this one was in flight.
      // Reporting that as undelivered would tell the owner someone is owed a reply that was delivered.
      this.log('[photon] a send failed after its entry was already settled or forgotten', message)
      return { sent: false, entryId: entry.id, error: message, settled: true }
    }
  }

  /**
   * Hands one entry to whichever transport this bot has. The Spectrum channel first, because a bot on an
   * existing project has no project key to send with; the HTTP client otherwise, authenticated with the
   * key the caller read for this bot. Neither available is a send that cannot happen yet, said as such so
   * the answer stays queued and the retry horizon — not a silent drop — is what ends it.
   */
  private async deliver(
    entry: PhotonOutboxEntry,
    credential: PhotonCredential | null
  ): Promise<void> {
    const transport = this.deps.transport?.(entry.botId)
    if (transport) {
      await transport.send(entry.conversationId, entry.body)
      return
    }
    if (!credential) {
      throw new Error(
        `This bot has neither a live Spectrum channel nor a Photon project key on this computer, so its answer stays queued.`
      )
    }
    await this.deps.api.sendMessage({
      credential,
      projectId: entry.projectId,
      conversationId: entry.conversationId,
      text: entry.body,
      // Derived from the entry, so a retry of a send that may already have landed replays rather
      // than arriving twice.
      idempotencyKey: `photon-send-${entry.id}`
    })
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
