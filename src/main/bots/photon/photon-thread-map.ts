// The one piece of state this channel genuinely adds: a Photon conversation id mapped to the bot chat
// that answers it. A second message in the same conversation continues that chat; a new conversation
// starts a new one. Persisted per bot, so a restart mid-conversation continues the thread instead of
// starting over — and the bot only ever answers a conversation it already has.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { writeDurableSecureJsonFile } from '../../../shared/secure-storage/secure-file'
import { isMissingFileError } from '../../runtime/rpc/server/pairing/device-registry-corruption'
import type { PhotonStore } from './photon-store'

const ThreadSchema = z.object({
  chatId: z.string().min(1),
  /** The number this conversation was answered on, as the provider reported it. */
  phoneNumber: z.string().min(1).optional(),
  /** The sender's handle, so a reply can name who it is talking to without re-reading the inbox. */
  handle: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type PhotonThread = z.infer<typeof ThreadSchema>

const ThreadFileSchema = z.object({ threads: z.record(z.string(), ThreadSchema) })
type ThreadFile = z.infer<typeof ThreadFileSchema>

/** A thread map Orca cannot read. Binding on top of it would rewrite the file and lose every
 *  conversation it mapped, so a bind refuses and says why; reading alone still answers "unknown". */
export class PhotonThreadMapUnreadableError extends Error {
  constructor(readonly path: string) {
    super(
      `Orca cannot read the Photon thread map at ${path}, so it will not overwrite it: move the file aside and every mapped conversation starts a new chat.`
    )
    this.name = 'PhotonThreadMapUnreadableError'
  }
}

export class PhotonThreadMap {
  private readonly cache = new Map<string, ThreadFile>()
  private readonly unreadable = new Set<string>()

  constructor(
    private readonly store: PhotonStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  thread(botId: string, conversationId: string): PhotonThread | null {
    return this.file(botId).threads[conversationId] ?? null
  }

  /** The chat that answers this conversation, or null when the bot has never seen it. */
  chatIdFor(botId: string, conversationId: string): string | null {
    return this.thread(botId, conversationId)?.chatId ?? null
  }

  /** Binds a conversation to the chat that took it. Rebinding updates the phone and handle, which is
   *  how a saved contact keeps working when the provider reports a different pool line. */
  bind(
    botId: string,
    conversationId: string,
    bind: { chatId: string; handle: string; phoneNumber?: string }
  ): PhotonThread {
    const file = this.file(botId)
    const existing = file.threads[conversationId]
    const at = this.now()
    const thread: PhotonThread = {
      chatId: bind.chatId,
      handle: bind.handle,
      ...(bind.phoneNumber ? { phoneNumber: bind.phoneNumber } : {}),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at
    }
    file.threads[conversationId] = thread
    this.write(botId, file)
    return thread
  }

  /** Drops a conversation, for a bot whose project is being released for good. */
  forget(botId: string, conversationId: string): void {
    const file = this.file(botId)
    if (!(conversationId in file.threads)) {
      return
    }
    delete file.threads[conversationId]
    this.write(botId, file)
  }

  /** Whether this bot has ever answered on a conversation; the send path's guard against a cold start. */
  knows(botId: string, conversationId: string): boolean {
    return this.chatIdFor(botId, conversationId) !== null
  }

  /** The conversation a chat answers, or null when the chat is not one this channel opened. Used at a
   *  turn's end, where the chat is known and the conversation is what has to be found. */
  conversationFor(botId: string, chatId: string): string | null {
    for (const [conversationId, thread] of Object.entries(this.file(botId).threads)) {
      if (thread.chatId === chatId) {
        return conversationId
      }
    }
    return null
  }

  private file(botId: string): ThreadFile {
    const cached = this.cache.get(botId)
    if (cached) {
      return cached
    }
    const path = this.store.threadPath(botId)
    const file = this.read(botId, path)
    this.cache.set(botId, file)
    return file
  }

  private read(botId: string, path: string): ThreadFile {
    let text: string
    try {
      text = readFileSync(path, 'utf-8')
    } catch (error) {
      if (!isMissingFileError(error)) {
        console.warn('[photon] could not read a thread map; treating its conversations as unknown')
      }
      return { threads: {} }
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      this.unreadable.add(botId)
      return { threads: {} }
    }
    const parsed = ThreadFileSchema.safeParse(raw)
    if (!parsed.success) {
      this.unreadable.add(botId)
      return { threads: {} }
    }
    return parsed.data
  }

  private write(botId: string, file: ThreadFile): void {
    if (this.unreadable.has(botId)) {
      throw new PhotonThreadMapUnreadableError(this.store.threadPath(botId))
    }
    const path = this.store.threadPath(botId)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeDurableSecureJsonFile(path, file)
  }
}
