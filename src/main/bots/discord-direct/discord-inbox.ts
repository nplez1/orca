// Orca's inventory of what the Discord gateway delivered: one file per inbound message, written before
// any turn starts. This is the crash guard and the dedupe index at once — a resume replays what the socket
// held, so a message id Orca already claimed must be dropped rather than run twice. `claimedAt` is the
// claim, `handledAt` is what the turn did, and a message between the two is one a crash landed on.
import { z } from 'zod'
import {
  listDiscordDir,
  readDiscordJson,
  removeDiscordDir,
  serialiseByFile,
  writeDiscordJson
} from './discord-files'
import { discordInboxDir, discordInboxPath, discordPathSegmentId } from './discord-store-paths'

const InboxEntrySchema = z.object({
  messageId: z.string().min(1),
  botId: z.string().min(1),
  receivedAt: z.number(),
  /** When Orca took it. Present means the message is Orca's, and a second delivery is a replay. */
  claimedAt: z.number().optional(),
  /** Set once the message has been answered or deliberately ignored. */
  handledAt: z.number().optional(),
  /** Set when Orca gave up: the message is kept, named, and out of the way. */
  parkedAt: z.number().optional(),
  parkedReason: z.string().optional()
})
export type DiscordInboxEntry = z.infer<typeof InboxEntrySchema>

/** What a listing says about a bot's inbox, which is what the owner can act on rather than infer. */
export type DiscordInboxSummary = {
  /** Messages Orca could not deal with, kept and named. */
  parked: number
  /** Messages claimed but never handled: a turn that crashed, so someone is owed an answer. */
  undelivered: number
}

async function readEntry(
  userDataPath: string,
  botId: string,
  messageId: string
): Promise<DiscordInboxEntry | null> {
  const read = await readDiscordJson(
    discordInboxPath(userDataPath, botId, messageId),
    'inbox entry'
  )
  if (read.kind !== 'parsed') {
    return null
  }
  const parsed = InboxEntrySchema.safeParse(read.value)
  return parsed.success ? parsed.data : null
}

async function writeEntry(userDataPath: string, entry: DiscordInboxEntry): Promise<void> {
  await writeDiscordJson(discordInboxPath(userDataPath, entry.botId, entry.messageId), entry)
}

/**
 * Takes one message into Orca's store. True means the caller owns the turn; false means Orca already
 * claimed or handled it, so a replay after a resume is dropped instead of answered twice. The write is
 * durable and happens before the caller starts anything, which is the point of the store.
 */
export function claim(userDataPath: string, botId: string, messageId: string): Promise<boolean> {
  return serialiseByFile(discordInboxPath(userDataPath, botId, messageId), async () => {
    const held = await readEntry(userDataPath, botId, messageId)
    if (held?.claimedAt !== undefined || held?.handledAt !== undefined) {
      return false
    }
    const at = Date.now()
    await writeEntry(userDataPath, {
      messageId,
      botId,
      receivedAt: held?.receivedAt ?? at,
      claimedAt: at
    })
    return true
  })
}

/** Records that the message is dealt with, so nothing replays it. No-op when it is not in the inbox. */
export async function markHandled(
  userDataPath: string,
  botId: string,
  messageId: string
): Promise<void> {
  const held = await readEntry(userDataPath, botId, messageId)
  if (!held || held.handledAt !== undefined) {
    return
  }
  await writeEntry(userDataPath, { ...held, handledAt: Date.now() })
}

/**
 * Gives a claim back, for a turn that could not start. Only an unhandled, unparked message is released:
 * releasing a handled one would let a replay answer it a second time, which is the double-run this store
 * exists to stop.
 */
export async function releaseClaim(
  userDataPath: string,
  botId: string,
  messageId: string
): Promise<boolean> {
  return serialiseByFile(discordInboxPath(userDataPath, botId, messageId), async () => {
    const held = await readEntry(userDataPath, botId, messageId)
    if (!held || held.handledAt !== undefined || held.parkedAt !== undefined) {
      return false
    }
    await removeDiscordDir(discordInboxPath(userDataPath, botId, messageId))
    return true
  })
}

/**
 * Gives up on one message: kept on disk, named, and marked handled so nothing replays it. Without this a
 * message nothing can deliver stays claimed for good, and the summary counts it as owed to someone.
 */
export async function park(
  userDataPath: string,
  botId: string,
  messageId: string,
  reason: string
): Promise<DiscordInboxEntry | null> {
  const held = await readEntry(userDataPath, botId, messageId)
  if (!held) {
    return null
  }
  const at = Date.now()
  const parked: DiscordInboxEntry = {
    ...held,
    handledAt: held.handledAt ?? at,
    parkedAt: held.parkedAt ?? at,
    parkedReason: reason.slice(0, 300)
  }
  await writeEntry(userDataPath, parked)
  return parked
}

/** One bot's inbox, counted. */
export async function summary(userDataPath: string, botId: string): Promise<DiscordInboxSummary> {
  const counts: DiscordInboxSummary = { parked: 0, undelivered: 0 }
  for (const name of await listDiscordDir(discordInboxDir(userDataPath, botId))) {
    if (!name.endsWith('.json')) {
      continue
    }
    const entry = await readEntry(userDataPath, botId, discordPathSegmentId(name.slice(0, -5)))
    if (!entry) {
      continue
    }
    if (entry.parkedAt !== undefined) {
      counts.parked += 1
    } else if (entry.claimedAt !== undefined && entry.handledAt === undefined) {
      counts.undelivered += 1
    }
  }
  return counts
}

/** Removes a bot's whole inbox, for a bot whose record is going away. */
export async function clearInbox(userDataPath: string, botId: string): Promise<void> {
  await removeDiscordDir(discordInboxDir(userDataPath, botId))
}
