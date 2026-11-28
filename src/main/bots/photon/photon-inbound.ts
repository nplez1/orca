// A Photon message becoming an ask. The order of operations here is the reliability design: take the
// message into Orca's store first, dispatch the turn second, and advance Photon's cursor third — never
// the other way round, because advancing on receipt would lose a message that a crash interrupted. The
// handler Photon means by "success" is "accepted into Orca's queue", not "the agent finished answering",
// which is what lets a four-minute turn hold no cursor at all.
//
// Two things make that order hold rather than merely describe it. Messages are handled **one at a time
// per project**, because they share one cursor: concurrent handlers let a later seq finish first and
// move the cursor past an earlier message that then fails, and Photon never redelivers it. And a
// message already being handled is refused rather than run again, because Photon documents duplicate
// delivery and two of the same text would open two chats — which the inbox's own dedupe refuses, because
// the chain means the repeat arrives after the first has been marked handled.
import type { BotRequestPerson } from '../../../shared/bots/bot-acts-for'
import type { PhotonCursorStore } from './photon-cursor'
import {
  PHOTON_INBOX_PARK_HORIZON_MS,
  type PhotonInbox,
  type PhotonInboxEntry
} from './photon-inbox'
import type { PhotonInboundMessage } from './photon-contract'
import type { PhotonThreadMap } from './photon-thread-map'

/** One of the bot's people, as its assignment list mirrors the provider's records. */
export type PhotonPerson = { name: string; role: 'owner' | 'member' }

export type PhotonInboundDeps = {
  inbox: PhotonInbox
  cursors: PhotonCursorStore
  threads: PhotonThreadMap
  /** The bot's people by handle. Only an assigned handle reaches the stream, so this is the allowlist
   *  as the provider holds it rather than a second ACL Orca keeps in sync. */
  people: (botId: string) => Promise<Map<string, PhotonPerson>>
  /** Who to attribute a message to when the bot has no allowlist of its own. A Spectrum project already
   *  decides who reaches its own lines in the owner's dashboard, so there is no assignment list here to
   *  mirror and "unknown handle" would mean the wrong thing. */
  defaultPerson?: (input: {
    botId: string
    handle: string
  }) => PhotonPerson | null | Promise<PhotonPerson | null>
  /** Whether the bot is paused, in which case its mail waits rather than starting a turn. */
  paused?: (botId: string) => boolean
  /** Records that a sender Orca has no assignment for reached the stream, which means this computer's
   *  mirror of the provider's allowlist is stale rather than that the sender is a stranger. */
  noteUnknownSender?: (botId: string) => void | Promise<void>
  /** Records that a message could not be delivered and was parked: what a listing shows rather than a
   *  silent gap where an answer should have been. */
  noteParkedMessage?: (botId: string, reason: string) => void | Promise<void>
  /** Starts a conversation the message opens; resolves the chat that will answer it. */
  startConversation: (input: {
    botId: string
    text: string
    person: BotRequestPerson
    title: string
  }) => Promise<{ chatId: string }>
  /** Delivers into a chat that already exists, which is how a follow-up continues one conversation.
   *  Throws when the chat refused the message: a refusal is not a delivery, and acking it would lose
   *  the owner's text silently. */
  sendToChat: (input: {
    botId: string
    chatId: string
    text: string
    person: BotRequestPerson
  }) => Promise<void>
  log?: (message: string, ...rest: unknown[]) => void
}

export type PhotonInboundOutcome =
  /** The message started a new chat, or continued the one its conversation already had. */
  | { kind: 'ran'; messageId: string; chatId: string; continued: boolean }
  /** A replay of something Orca already handled, or of a delivery already in hand; nothing ran. */
  | { kind: 'replayed'; messageId: string }
  /** Recorded, deliberately not acted on: the sender is not one of the bot's people. */
  | { kind: 'ignored'; messageId: string; reason: 'unknown-handle' }
  /** Recorded and deliberately held: the bot is paused, so this is replayed when it resumes. */
  | { kind: 'held'; messageId: string }
  /** Given up on after repeated failures: kept on disk, named, and out of the way of later messages. */
  | { kind: 'parked'; messageId: string; reason: string }

/** Handles compare case-insensitively and without the separators people type in a phone number. */
export function normalisePhotonHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase()
  return trimmed.includes('@') ? trimmed : trimmed.replace(/[^0-9+]/g, '')
}

/** Only the last four digits: enough to recognise whose message was dropped, not enough to be a
 *  phone number in a log. */
export function photonHandleTail(handle: string): string {
  const normalised = normalisePhotonHandle(handle)
  return normalised.length <= 4 ? '…' : `…${normalised.slice(-4)}`
}

export class PhotonInbound {
  private readonly log: (message: string, ...rest: unknown[]) => void
  /** One chain per project: the cursor is shared, so the handlers must be ordered. */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly deps: PhotonInboundDeps) {
    this.log = deps.log ?? ((message, ...rest) => console.warn(message, ...rest))
  }

  /** Handles one frame, in order behind everything else for this project. */
  handle(input: {
    botId: string
    projectId: string
    seq: number
    message: PhotonInboundMessage
  }): Promise<PhotonInboundOutcome> {
    return this.serialise(input.projectId, () => this.handleInOrder(input))
  }

  /**
   * Replays what Orca wrote down and never dealt with, oldest first. This is the recovery the crash
   * guard exists for: a message whose dispatch never happened would otherwise depend on Photon choosing
   * to redeliver it, which replay is not obligated to do. Runs in the same order as live frames, so a
   * recovered message cannot overtake one that arrived after it.
   */
  async recover(input: { botId: string; projectId: string }): Promise<PhotonInboundOutcome[]> {
    const outcomes: PhotonInboundOutcome[] = []
    for (const entry of await this.deps.inbox.unhandled(input.projectId)) {
      const seq = entry.seq
      if (seq === undefined) {
        this.log(
          '[photon] an inbox entry has no stream position, so it cannot be replayed; it stays for inspection',
          entry.messageId.slice(0, 40)
        )
        continue
      }
      outcomes.push(
        await this.handle({
          botId: input.botId,
          projectId: input.projectId,
          seq,
          message: messageOf(entry)
        })
      )
    }
    return outcomes
  }

  private serialise<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve()
    const next = previous.then(work, work)
    // The chain never rejects: a failed item is that item's caller's problem, not the queue's.
    this.queues.set(
      projectId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  private async handleInOrder(input: {
    botId: string
    projectId: string
    seq: number
    message: PhotonInboundMessage
  }): Promise<PhotonInboundOutcome> {
    const { inbox, threads } = this.deps
    const messageId = input.message.id
    // A duplicate delivery needs no guard of its own: this chain serialises messages, so a repeat always
    // arrives after the first finished, and `claim` finds its `handledAt` and skips it. A second belt
    // here would be a branch nothing can reach.
    const claim = await inbox.claim(input.projectId, input.message, input.seq)
    if (claim.action === 'skip') {
      // Already Orca's, already dispatched. Moving the cursor is all that is left, and it is safe
      // because the message is durably in the inbox.
      await this.advance(input, claim.entry.messageId)
      return { kind: 'replayed', messageId: claim.entry.messageId }
    }

    const person = await this.personFor(input.botId, input.message)
    if (!person) {
      // Photon only delivers senders its own assignment list holds, so "unknown" means this computer's
      // mirror is stale — usually an assignment that was made upstream and never persisted here. It is
      // recorded and acked (there is nothing to answer and nothing to retry), and counted so a listing
      // can say the mirror needs repairing.
      this.log(
        '[photon] ignoring a message from a handle this bot has no assignment for; its mirror is stale',
        photonHandleTail(input.message.sender.handle)
      )
      await this.deps.noteUnknownSender?.(input.botId)
      await inbox.markHandled(input.projectId, messageId)
      await this.advance(input, messageId)
      return { kind: 'ignored', messageId, reason: 'unknown-handle' }
    }

    if (this.deps.paused?.(input.botId)) {
      // Held, not dropped: no `handledAt` and no cursor move means the recovery replays it when the bot
      // is resumed, which is the same shape as a crash between the write and the dispatch.
      this.log('[photon] the bot is paused; its message waits in the inbox')
      return { kind: 'held', messageId }
    }

    try {
      const known = await threads.chatIdFor(input.botId, input.message.conversationId)
      if (known) {
        await this.deps.sendToChat({
          botId: input.botId,
          chatId: known,
          text: input.message.text,
          person
        })
        await inbox.markHandled(input.projectId, messageId)
        await this.advance(input, messageId)
        return { kind: 'ran', messageId, chatId: known, continued: true }
      }

      const started = await this.deps.startConversation({
        botId: input.botId,
        text: input.message.text,
        person,
        title: photonConversationTitle(input.message)
      })
      await threads.bind(input.botId, input.message.conversationId, {
        chatId: started.chatId,
        handle: normalisePhotonHandle(input.message.sender.handle)
      })
      await inbox.markHandled(input.projectId, messageId)
      await this.advance(input, messageId)
      return { kind: 'ran', messageId, chatId: started.chatId, continued: false }
    } catch (error) {
      // A dispatch that failed is retried from the checkpoint, which is what the cursor is for. A
      // dispatch that fails *the same way* every time — a thread whose chat was deleted or retired —
      // is a message nothing can deliver, and replaying it forever is worse than either answering or
      // losing it: the entry stays unhandled, so `blocked-by-unhandled` stops the cursor and every
      // later message queues behind one that will never be dealt with. So it is parked, named, and
      // counted, and the owner can see it instead of a bot that has quietly gone deaf.
      const failingFor = await inbox.recordAttempt(input.projectId, messageId)
      const reason = error instanceof Error ? error.message : String(error)
      if (failingFor < PHOTON_INBOX_PARK_HORIZON_MS) {
        throw error
      }
      await inbox.park(input.projectId, messageId, reason)
      this.log(
        '[photon] parking a message nothing has been able to deliver for',
        Math.round(failingFor / 60_000),
        'minutes:',
        reason
      )
      await this.deps.noteParkedMessage?.(input.botId, reason)
      await this.advance(input, messageId)
      return { kind: 'parked', messageId, reason }
    }
  }

  /** The cursor moves only with the inbox entry as evidence, so a caller that never wrote the message
   *  gets a refusal instead of a lost delivery. */
  private async advance(
    input: { projectId: string; seq: number },
    messageId: string
  ): Promise<void> {
    const result = await this.deps.cursors.advance(input.projectId, input.seq, {
      inboxHas: (id) => this.deps.inbox.has(input.projectId, id),
      messageId,
      unhandledAtOrBelow: (seq) =>
        this.deps.inbox.unhandledAtOrBelow(input.projectId, seq, messageId)
    })
    if (!result.advanced && result.reason === 'not-in-inbox') {
      this.log(
        '[photon] refusing to advance a cursor past a message the inbox does not hold',
        messageId.slice(0, 40)
      )
    }
    if (!result.advanced && result.reason === 'blocked-by-unhandled') {
      // Correct, and worth saying: the cursor stops at the older message until it is dealt with, and the
      // recovery replays it.
      this.log(
        '[photon] holding the cursor at an earlier message that was never dealt with',
        result.messageId.slice(0, 40)
      )
    }
  }

  private async personFor(
    botId: string,
    message: PhotonInboundMessage
  ): Promise<BotRequestPerson | null> {
    const handle = normalisePhotonHandle(message.sender.handle)
    const people = await this.deps.people(botId)
    const fallback = this.deps.defaultPerson
      ? await this.deps.defaultPerson({ botId, handle })
      : null
    const found = people.get(handle) ?? fallback
    if (!found) {
      return null
    }
    const name = message.sender.name?.trim() || found.name
    return {
      kind: 'person',
      source: 'photon',
      userId: message.sender.handle,
      ...(name ? { name } : {}),
      workspaceId: null,
      role: found.role
    }
  }
}

/** An inbox entry as the message it held, for a replay that has no frame to read. */
function messageOf(entry: PhotonInboxEntry): PhotonInboundMessage {
  return {
    id: entry.messageId,
    conversationId: entry.conversationId,
    sender: entry.sender,
    text: entry.text,
    createdAt: entry.createdAt
  }
}

/** The chat's title, from who texted rather than from what they said: the message is already the prompt. */
export function photonConversationTitle(message: PhotonInboundMessage): string {
  const who = message.sender.name?.trim() || message.sender.handle
  return `Photon · ${who}`
}
