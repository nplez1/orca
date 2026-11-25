// Outbound answers that have not landed yet. A turn's reply is written here before it is sent, so a crash
// between the turn ending and the send going out replays instead of losing the answer — and because a
// long reply is several messages, the entry counts the parts already sent. That count is the whole point:
// a retry resumes at `sentParts`, so a part that landed is never sent twice.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { readDiscordJson, serialiseByFile, writeDiscordJson } from './discord-files'
import { discordOutboxPath } from './discord-store-paths'

/** Discord caps a nonce at 25 characters, and `enforce_nonce` dedupes per part, so each part needs its
 *  own: this is the entry's 16 hex characters of SHA-256 plus the part index, stable across restarts
 *  because it is derived from the entry id rather than stored per attempt. */
export function nonceFor(entryId: string, partIndex: number): string {
  return `${nonceBase(entryId)}:${partIndex}`
}

const nonceBase = (entryId: string): string =>
  createHash('sha256').update(entryId).digest('hex').slice(0, 16)

export const DiscordOutboxEntrySchema = z.object({
  entryId: z.string().min(1),
  botId: z.string().min(1),
  channelId: z.string().min(1),
  /** The chunks the answer was cut into, in order. */
  parts: z.array(z.string()).min(1),
  /** How many parts landed. A retry starts at this index, never at zero. */
  sentParts: z.number().int().nonnegative().default(0),
  /** The nonce base `nonceFor(entryId, partIndex)` composes, kept so a resumed entry's nonces are
   *  visible in the file rather than only derivable from the code. */
  nonceFor: z.string().min(1),
  createdAt: z.number()
})
export type DiscordOutboxEntry = z.infer<typeof DiscordOutboxEntrySchema>

const OutboxFileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  entries: z.array(DiscordOutboxEntrySchema).default([])
})
type OutboxFile = z.infer<typeof OutboxFileSchema>

const emptyFile = (): OutboxFile => ({ schemaVersion: 1, entries: [] })

async function readFile(userDataPath: string): Promise<OutboxFile> {
  const read = await readDiscordJson(discordOutboxPath(userDataPath), 'outbox')
  if (read.kind !== 'parsed') {
    return emptyFile()
  }
  const parsed = OutboxFileSchema.safeParse(read.value)
  if (!parsed.success) {
    console.warn('[discord] the outbox is unreadable; starting empty', parsed.error.issues)
    return emptyFile()
  }
  return parsed.data
}

function change<T>(
  userDataPath: string,
  mutate: (file: OutboxFile) => T | null
): Promise<T | null> {
  return serialiseByFile(discordOutboxPath(userDataPath), async () => {
    const file = await readFile(userDataPath)
    const result = mutate(file)
    if (result === null) {
      return null
    }
    await writeDiscordJson(discordOutboxPath(userDataPath), file)
    return result
  })
}

/** Records a reply before it is attempted. Enqueuing the same entry id again is a no-op, so a replay that
 *  races a retry cannot double-send. */
export async function enqueue(
  userDataPath: string,
  entry: { entryId: string; botId: string; channelId: string; parts: string[] }
): Promise<DiscordOutboxEntry> {
  const saved = await change(userDataPath, (file) => {
    const existing = file.entries.find((candidate) => candidate.entryId === entry.entryId)
    if (existing) {
      return existing
    }
    const queued: DiscordOutboxEntry = {
      entryId: entry.entryId,
      botId: entry.botId,
      channelId: entry.channelId,
      parts: entry.parts,
      sentParts: 0,
      nonceFor: nonceBase(entry.entryId),
      createdAt: Date.now()
    }
    file.entries.push(queued)
    return queued
  })
  if (!saved) {
    throw new Error('a reply could not be recorded in the outbox')
  }
  return saved
}

/** The oldest entry with a part left to send, or null. Insertion order is the order replies were made, so
 *  two entries stamped in the same millisecond still resume in the right one. */
export async function nextPending(
  userDataPath: string,
  botId: string
): Promise<DiscordOutboxEntry | null> {
  const file = await readFile(userDataPath)
  return (
    file.entries.find((entry) => entry.botId === botId && entry.sentParts < entry.parts.length) ??
    null
  )
}

/** Records that one part landed. Only ever forward, so a duplicate acknowledgement cannot rewind the
 *  entry and make a retry resend a part Discord already has. */
export async function markPartSent(
  userDataPath: string,
  entryId: string,
  partIndex: number
): Promise<DiscordOutboxEntry | null> {
  return change(userDataPath, (file) => {
    const index = file.entries.findIndex((entry) => entry.entryId === entryId)
    if (index === -1) {
      return null
    }
    const entry = file.entries[index]
    if (!entry) {
      return null
    }
    const sentParts = Math.max(entry.sentParts, Math.min(partIndex + 1, entry.parts.length))
    if (sentParts === entry.sentParts) {
      // Already recorded: the caller gets the entry it has, not a null it would read as "gone".
      return entry
    }
    const next = { ...entry, sentParts }
    file.entries[index] = next
    return next
  })
}

/** The reply landed: gone from here, so nothing retries it. */
export async function complete(userDataPath: string, entryId: string): Promise<void> {
  await change(userDataPath, (file) => {
    const before = file.entries.length
    file.entries = file.entries.filter((entry) => entry.entryId !== entryId)
    return file.entries.length !== before ? true : null
  })
}

/** Gives up on a reply, returning what was dropped so the caller can report it: an answer nobody received
 *  is a fact to name, not a line to leave in a file that grows with the bot's history. */
export async function drop(
  userDataPath: string,
  entryId: string,
  reason: string
): Promise<DiscordOutboxEntry | null> {
  const dropped = await change(userDataPath, (file) => {
    const entry = file.entries.find((candidate) => candidate.entryId === entryId)
    if (!entry) {
      return null
    }
    file.entries = file.entries.filter((candidate) => candidate.entryId !== entryId)
    return entry
  })
  if (dropped) {
    console.warn(
      '[discord] giving up on a reply after',
      dropped.sentParts,
      'of',
      dropped.parts.length,
      'parts:',
      reason
    )
  }
  return dropped
}

/** Drops everything queued for a bot whose record is going away. */
export async function forgetBot(userDataPath: string, botId: string): Promise<void> {
  await change(userDataPath, (file) => {
    const before = file.entries.length
    file.entries = file.entries.filter((entry) => entry.botId !== botId)
    return file.entries.length !== before ? true : null
  })
}
