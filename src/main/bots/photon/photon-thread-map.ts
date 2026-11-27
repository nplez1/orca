// The one piece of state this channel genuinely adds: a Photon conversation id mapped to the bot chat
// that answers it. A second message in the same conversation continues that chat; a new conversation
// starts a new one. Persisted per bot, so a restart mid-conversation continues the thread instead of
// starting over — and the bot only ever answers a conversation it already has.
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { readPhotonJson, writePhotonJson } from './photon-files'
import type { PhotonStore } from './photon-store'

const ThreadSchema = lazyZodSchema(() =>
  z.object({
    chatId: z.string().min(1),
    /** The number this conversation was answered on, as the provider reported it. */
    phoneNumber: z.string().min(1).optional(),
    /** The sender's handle, so a reply can name who it is talking to without re-reading the inbox. */
    handle: z.string().min(1),
    createdAt: z.number(),
    updatedAt: z.number()
  })
)
export type PhotonThread = z.infer<typeof ThreadSchema>

const ThreadFileSchema = lazyZodSchema(() =>
  z.object({ threads: z.record(z.string(), ThreadSchema) })
)
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
  private readonly cache = new Map<string, Promise<ThreadFile>>()
  private readonly unreadable = new Set<string>()
  private readonly queue = new Map<string, Promise<void>>()

  constructor(
    private readonly store: PhotonStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  async thread(botId: string, conversationId: string): Promise<PhotonThread | null> {
    return (await this.file(botId)).threads[conversationId] ?? null
  }

  /** The chat that answers this conversation, or null when the bot has never seen it. */
  async chatIdFor(botId: string, conversationId: string): Promise<string | null> {
    return (await this.thread(botId, conversationId))?.chatId ?? null
  }

  /** Binds a conversation to the chat that took it. Rebinding updates the phone and handle, which is
   *  how a saved contact keeps working when the provider reports a different pool line. */
  async bind(
    botId: string,
    conversationId: string,
    bind: { chatId: string; handle: string; phoneNumber?: string }
  ): Promise<PhotonThread> {
    const at = this.now()
    let bound: PhotonThread | null = null
    await this.change(botId, (file) => {
      const existing = file.threads[conversationId]
      bound = {
        chatId: bind.chatId,
        handle: bind.handle,
        ...(bind.phoneNumber ? { phoneNumber: bind.phoneNumber } : {}),
        createdAt: existing?.createdAt ?? at,
        updatedAt: at
      }
      file.threads[conversationId] = bound
      return true
    })
    if (!bound) {
      throw new PhotonThreadMapUnreadableError(this.store.threadPath(botId))
    }
    return bound
  }

  /** Drops a conversation, for a bot whose project is being released for good. */
  async forget(botId: string, conversationId: string): Promise<void> {
    await this.change(botId, (file) => {
      if (!(conversationId in file.threads)) {
        return false
      }
      delete file.threads[conversationId]
      return true
    })
  }

  /** Whether this bot has ever answered on a conversation; the send path's guard against a cold start. */
  async knows(botId: string, conversationId: string): Promise<boolean> {
    return (await this.chatIdFor(botId, conversationId)) !== null
  }

  /** The conversation a chat answers, or null when the chat is not one this channel opened. Used at a
   *  turn's end, where the chat is known and the conversation is what has to be found. */
  async conversationFor(botId: string, chatId: string): Promise<string | null> {
    for (const [conversationId, thread] of Object.entries((await this.file(botId)).threads)) {
      if (thread.chatId === chatId) {
        return conversationId
      }
    }
    return null
  }

  private file(botId: string): Promise<ThreadFile> {
    const cached = this.cache.get(botId)
    if (cached) {
      return cached
    }
    const reading = this.read(botId)
    this.cache.set(botId, reading)
    return reading
  }

  private async read(botId: string): Promise<ThreadFile> {
    const path = this.store.threadPath(botId)
    const read = await readPhotonJson(path, 'thread map')
    if (read.kind === 'missing') {
      return { threads: {} }
    }
    if (read.kind === 'unreadable') {
      this.unreadable.add(botId)
      return { threads: {} }
    }
    const parsed = ThreadFileSchema.safeParse(read.value)
    if (!parsed.success) {
      this.unreadable.add(botId)
      return { threads: {} }
    }
    return parsed.data
  }

  /** One change at a time per bot, over the state its predecessor left. */
  private change(botId: string, mutate: (file: ThreadFile) => boolean): Promise<void> {
    const previous = this.queue.get(botId) ?? Promise.resolve()
    const run = previous.then(async () => {
      if (this.unreadable.has(botId)) {
        throw new PhotonThreadMapUnreadableError(this.store.threadPath(botId))
      }
      const file = await this.file(botId)
      // Mutating a copy keeps the cache consistent if the write fails.
      const draft = structuredClone(file)
      if (!mutate(draft)) {
        return
      }
      await writePhotonJson(this.store.threadPath(botId), draft)
      this.cache.set(botId, Promise.resolve(draft))
    })
    this.queue.set(
      botId,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }
}
