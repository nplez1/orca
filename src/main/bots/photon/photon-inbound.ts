// A Photon message becoming an ask. The order of operations here is the reliability design: take the
// message into Orca's store first, dispatch the turn second, and advance Photon's cursor third — never
// the other way round, because advancing on receipt would lose a message that a crash interrupted. The
// handler Photon means by "success" is "accepted into Orca's queue", not "the agent finished answering",
// which is what lets a four-minute turn hold no cursor at all.
import type { BotRequestPerson } from '../../../shared/bots/bot-acts-for'
import type { PhotonCursorStore } from './photon-cursor'
import type { PhotonInbox } from './photon-inbox'
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
  people: (botId: string) => Map<string, PhotonPerson>
  /** Starts a conversation the message opens; resolves the chat that will answer it. */
  startConversation: (input: {
    botId: string
    text: string
    person: BotRequestPerson
    title: string
  }) => Promise<{ chatId: string }>
  /** Delivers into a chat that already exists, which is how a follow-up continues one conversation. */
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
  /** A replay of something Orca already handled; nothing ran, which is the point. */
  | { kind: 'replayed'; messageId: string }
  /** Recorded, deliberately not acted on: the sender is not one of the bot's people. */
  | { kind: 'ignored'; messageId: string; reason: 'unknown-handle' }

/** Handles compare case-insensitively and without the separators people type in a phone number. */
export function normalisePhotonHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase()
  return trimmed.includes('@') ? trimmed : trimmed.replace(/[^0-9+]/g, '')
}

export class PhotonInbound {
  private readonly log: (message: string, ...rest: unknown[]) => void

  constructor(private readonly deps: PhotonInboundDeps) {
    this.log = deps.log ?? ((message, ...rest) => console.warn(message, ...rest))
  }

  async handle(input: {
    botId: string
    projectId: string
    seq: number
    message: PhotonInboundMessage
  }): Promise<PhotonInboundOutcome> {
    const { inbox, threads } = this.deps
    const claim = inbox.claim(input.projectId, input.message)
    if (claim.action === 'skip') {
      // Already Orca's, already dispatched. Moving the cursor is all that is left, and it is safe
      // because the message is durably in the inbox.
      this.advance(input, claim.entry.messageId)
      return { kind: 'replayed', messageId: claim.entry.messageId }
    }

    const person = this.personFor(input.botId, input.message)
    if (!person) {
      // An unknown handle never becomes an instruction. On this channel it should not even reach the
      // stream, so this is a defensive branch rather than the access-request path: the answer is "add
      // them, then they can text", not a queue that never fills.
      this.log(
        '[photon] ignoring a message from an unassigned handle',
        normalisePhotonHandle(input.message.sender.handle)
      )
      inbox.markHandled(input.projectId, input.message.id)
      this.advance(input, input.message.id)
      return { kind: 'ignored', messageId: input.message.id, reason: 'unknown-handle' }
    }

    const known = threads.chatIdFor(input.botId, input.message.conversationId)
    if (known) {
      await this.deps.sendToChat({
        botId: input.botId,
        chatId: known,
        text: input.message.text,
        person
      })
      inbox.markHandled(input.projectId, input.message.id)
      this.advance(input, input.message.id)
      return { kind: 'ran', messageId: input.message.id, chatId: known, continued: true }
    }

    const started = await this.deps.startConversation({
      botId: input.botId,
      text: input.message.text,
      person,
      title: photonConversationTitle(input.message)
    })
    threads.bind(input.botId, input.message.conversationId, {
      chatId: started.chatId,
      handle: normalisePhotonHandle(input.message.sender.handle)
    })
    inbox.markHandled(input.projectId, input.message.id)
    this.advance(input, input.message.id)
    return {
      kind: 'ran',
      messageId: input.message.id,
      chatId: started.chatId,
      continued: false
    }
  }

  /** The cursor moves only with the inbox entry as evidence, so a caller that never wrote the message
   *  gets a refusal instead of a lost delivery. */
  private advance(input: { projectId: string; seq: number }, messageId: string): void {
    const result = this.deps.cursors.advance(input.projectId, input.seq, {
      inboxHas: (id) => this.deps.inbox.has(input.projectId, id),
      messageId
    })
    if (!result.advanced && result.reason === 'not-in-inbox') {
      this.log(
        '[photon] refusing to advance a cursor past a message the inbox does not hold',
        messageId
      )
    }
  }

  private personFor(botId: string, message: PhotonInboundMessage): BotRequestPerson | null {
    const people = this.deps.people(botId)
    const found = people.get(normalisePhotonHandle(message.sender.handle))
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

/** The chat's title, from who texted rather than from what they said: the message is already the prompt. */
export function photonConversationTitle(message: PhotonInboundMessage): string {
  const who = message.sender.name?.trim() || message.sender.handle
  return `Photon · ${who}`
}
