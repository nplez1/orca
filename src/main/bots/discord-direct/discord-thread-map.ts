// The one piece of state this channel genuinely adds: a Discord channel id mapped to the bot chat that
// answers it. One channel is one chat — a direct message channel, a thread, or the channel a mention
// arrived in — so a second message in the same channel continues that chat instead of starting another.
// Persisted per bot, so a restart mid-conversation continues the thread rather than forgetting it.
import { z } from 'zod'
import { readDiscordJson, serialiseByFile, writeDiscordJson } from './discord-files'
import { discordThreadPath } from './discord-store-paths'

/** Snowflakes are 64-bit and exceed `Number.MAX_SAFE_INTEGER`, so they are compared as BigInt strings;
 *  `Number` would make 9007199254740992 and 9007199254740993 equal. */
const SNOWFLAKE = /^\d{1,25}$/

export const DiscordChannelEntrySchema = z.object({
  chatId: z.string().min(1),
  /** How the channel came to exist, which decides how a reply is threaded back. */
  kind: z.enum(['dm', 'thread', 'inline']),
  guildId: z.string().min(1).optional(),
  channelId: z.string().min(1),
  /** Who opened it, so the bot knows whose conversation this is without re-reading the message. */
  openerUserId: z.string().min(1),
  /** The newest message dealt with in this channel; `0` is the floor, so any snowflake is ahead of it. */
  lastHandledMessageId: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type DiscordChannelEntry = z.infer<typeof DiscordChannelEntrySchema>

const ThreadFileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  /** Keyed by channel id: the identity Discord gives a conversation, and the only one that is stable. */
  channels: z.record(z.string(), DiscordChannelEntrySchema).default({})
})
type ThreadFile = z.infer<typeof ThreadFileSchema>

/** What a bind supplies; the store owns the timestamps and the floor. */
export type DiscordChannelBind = Omit<
  DiscordChannelEntry,
  'createdAt' | 'updatedAt' | 'lastHandledMessageId'
> & { lastHandledMessageId?: string }

/** A map Orca cannot read. Binding on top of it would rewrite the file and lose every chat it mapped, so
 *  a bind refuses and says why; reading alone still answers "unknown". */
export class DiscordThreadMapUnreadableError extends Error {
  constructor(readonly path: string) {
    super(
      `Orca cannot read the Discord thread map at ${path}, so it will not overwrite it: move the file aside and every mapped channel starts a new chat.`
    )
    this.name = 'DiscordThreadMapUnreadableError'
  }
}

const emptyFile = (): ThreadFile => ({ schemaVersion: 1, channels: {} })

async function readFile(userDataPath: string, botId: string): Promise<ThreadFile | null> {
  const read = await readDiscordJson(discordThreadPath(userDataPath, botId), 'thread map')
  if (read.kind === 'missing') {
    return emptyFile()
  }
  if (read.kind === 'unreadable') {
    return null
  }
  const parsed = ThreadFileSchema.safeParse(read.value)
  return parsed.success ? parsed.data : null
}

function change(
  userDataPath: string,
  botId: string,
  mutate: (file: ThreadFile) => boolean
): Promise<void> {
  return serialiseByFile(discordThreadPath(userDataPath, botId), async () => {
    const file = await readFile(userDataPath, botId)
    if (!file) {
      throw new DiscordThreadMapUnreadableError(discordThreadPath(userDataPath, botId))
    }
    if (!mutate(file)) {
      return
    }
    await writeDiscordJson(discordThreadPath(userDataPath, botId), file)
  })
}

/** The chat that answers this channel, or null when the bot has never seen it. */
export async function findByChannel(
  userDataPath: string,
  botId: string,
  channelId: string
): Promise<DiscordChannelEntry | null> {
  const file = await readFile(userDataPath, botId)
  return file?.channels[channelId] ?? null
}

/** Every channel this bot has a chat for, oldest first. */
export async function allConversations(
  userDataPath: string,
  botId: string
): Promise<DiscordChannelEntry[]> {
  const file = await readFile(userDataPath, botId)
  if (!file) {
    return []
  }
  return Object.values(file.channels).sort((left, right) => left.createdAt - right.createdAt)
}

/** Binds a channel to the chat that took it. A rebind updates the same entry — the channel is the
 *  identity, so a second bind cannot make a second chat — and never rewinds the handled mark. */
export async function bindChannel(
  userDataPath: string,
  botId: string,
  bind: DiscordChannelBind
): Promise<DiscordChannelEntry> {
  const at = Date.now()
  let bound: DiscordChannelEntry | null = null
  await change(userDataPath, botId, (file) => {
    const existing = file.channels[bind.channelId]
    const handled = bind.lastHandledMessageId ?? existing?.lastHandledMessageId ?? '0'
    bound = {
      chatId: bind.chatId,
      kind: bind.kind,
      ...(bind.guildId ? { guildId: bind.guildId } : {}),
      channelId: bind.channelId,
      openerUserId: bind.openerUserId,
      lastHandledMessageId: furthestSnowflake(existing?.lastHandledMessageId ?? '0', handled),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at
    }
    file.channels[bind.channelId] = bound
    return true
  })
  if (!bound) {
    throw new DiscordThreadMapUnreadableError(discordThreadPath(userDataPath, botId))
  }
  return bound
}

/** Drops a chat, for a conversation the owner ended or a channel that went away. */
export async function unbindChat(
  userDataPath: string,
  botId: string,
  chatId: string
): Promise<boolean> {
  let removed = false
  await change(userDataPath, botId, (file) => {
    const channelId = Object.keys(file.channels).find(
      (candidate) => file.channels[candidate]?.chatId === chatId
    )
    if (!channelId) {
      return false
    }
    delete file.channels[channelId]
    removed = true
    return true
  })
  return removed
}

/** Moves the channel's handled mark to `messageId`, and only forward: a resume replays what the gateway
 *  held, so a message already dealt with must not be handed to a turn again. False means it did not
 *  move — behind the stored mark, equal to it, not a snowflake, or a channel this bot does not know. */
export async function advanceHandled(
  userDataPath: string,
  botId: string,
  channelId: string,
  messageId: string
): Promise<boolean> {
  if (!SNOWFLAKE.test(messageId)) {
    return false
  }
  let advanced = false
  await change(userDataPath, botId, (file) => {
    const entry = file.channels[channelId]
    if (!entry || !isAhead(messageId, entry.lastHandledMessageId)) {
      return false
    }
    file.channels[channelId] = { ...entry, lastHandledMessageId: messageId, updatedAt: Date.now() }
    advanced = true
    return true
  })
  return advanced
}

/** True when `candidate` is strictly after `stored`, compared as BigInt so neighbours above 2^53 stay
 *  distinct. A stored value that is not a snowflake reads as the floor rather than throwing. */
function isAhead(candidate: string, stored: string): boolean {
  if (!SNOWFLAKE.test(stored)) {
    return true
  }
  return BigInt(candidate) > BigInt(stored)
}

function furthestSnowflake(left: string, right: string): string {
  return isAhead(right, left) ? right : left
}
