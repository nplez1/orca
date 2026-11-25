// The direct Discord channel's non-secret record: one entry per bot the owner pasted a token for, and the
// two settings a listing needs. Async throughout, because a delivery and a turn end both read it on
// Electron's main thread. A record this build cannot parse is kept verbatim on every rewrite: dropping it
// would forget a bot whose token is still sealed on this machine.
import { z } from 'zod'
import { readDiscordJson, serialiseByFile, writeDiscordJson } from './discord-files'
import { discordRecordPath } from './discord-store-paths'
import { removeDiscordToken } from './discord-secrets'

/** How many unknown senders a record keeps: enough to show who is being ignored, bounded so the record
 *  cannot grow with a stranger's retry loop. */
export const DISCORD_UNKNOWN_SENDER_LIMIT = 10

const UnknownSenderSchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1)
})
export type DiscordUnknownSender = z.infer<typeof UnknownSenderSchema>

export const DiscordBotRecordSchema = z.object({
  botId: z.string().min(1),
  applicationId: z.string().min(1),
  botUserId: z.string().min(1),
  username: z.string().min(1),
  /** `invalid` is what Discord's 401 says: the token is dead and the owner has to paste a new one. */
  tokenState: z.enum(['ok', 'invalid']).default('ok'),
  /** Off by default: a bot that answers strangers in a server is a choice, not an accident. */
  answerInServers: z.boolean().default(false),
  unknownSenders: z.array(UnknownSenderSchema).max(DISCORD_UNKNOWN_SENDER_LIMIT).default([]),
  createdAt: z.number()
})
export type DiscordBotRecord = z.infer<typeof DiscordBotRecordSchema>

/** What a caller hands over after a token was checked: the record fields, minus the one only the store
 *  sets. Taken from the schema's input type, so a caller need not repeat the defaults. */
export type DiscordBotRecordInput = Omit<z.input<typeof DiscordBotRecordSchema>, 'createdAt'> & {
  createdAt?: number
}

/** The file's envelope. `bots` is held as `unknown` so a record written by a newer build survives a
 *  rewrite this build makes. */
const StoredFileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  bots: z.array(z.unknown()).default([])
})
type StoredFile = z.infer<typeof StoredFileSchema>

/** A file this store cannot read is never silently replaced: overwriting it would forget every bot whose
 *  token is still sealed here. The caller gets this and decides. */
export class DiscordStoreUnreadableError extends Error {
  constructor(readonly path: string) {
    super(
      `Orca cannot read ${path}, so it will not overwrite it: that file may name bots whose tokens still exist. Move it aside to start over.`
    )
    this.name = 'DiscordStoreUnreadableError'
  }
}

const emptyFile = (): StoredFile => ({ schemaVersion: 1, bots: [] })

/** The id a raw entry claims, so an unparseable record can still be matched and left alone. */
const RawBotIdSchema = z.object({ botId: z.string().min(1) })

function rawBotId(raw: unknown): string | null {
  const parsed = RawBotIdSchema.safeParse(raw)
  return parsed.success ? parsed.data.botId : null
}

async function readStoredFile(userDataPath: string): Promise<StoredFile> {
  const read = await readDiscordJson(discordRecordPath(userDataPath), 'record')
  if (read.kind !== 'parsed') {
    return emptyFile()
  }
  const parsed = StoredFileSchema.safeParse(read.value)
  return parsed.success ? parsed.data : emptyFile()
}

async function readOrRefuse(userDataPath: string): Promise<StoredFile> {
  const path = discordRecordPath(userDataPath)
  const read = await readDiscordJson(path, 'record')
  if (read.kind === 'missing') {
    return emptyFile()
  }
  if (read.kind === 'unreadable') {
    throw new DiscordStoreUnreadableError(path)
  }
  const parsed = StoredFileSchema.safeParse(read.value)
  if (!parsed.success) {
    console.warn(
      '[discord] the record is unreadable; keeping the file rather than starting over',
      parsed.error.issues.map((issue) => issue.path.join('.') || 'root')
    )
    throw new DiscordStoreUnreadableError(path)
  }
  return parsed.data
}

/** Every bot this build can read; an entry it cannot parse is skipped, not deleted. */
export async function readDiscordStore(userDataPath: string): Promise<DiscordBotRecord[]> {
  const file = await readStoredFile(userDataPath)
  const records: DiscordBotRecord[] = []
  for (const raw of file.bots) {
    const parsed = DiscordBotRecordSchema.safeParse(raw)
    if (parsed.success) {
      records.push(parsed.data)
    }
  }
  return records
}

function change<T>(
  userDataPath: string,
  mutate: (file: StoredFile) => T | null
): Promise<T | null> {
  return serialiseByFile(discordRecordPath(userDataPath), async () => {
    const file = await readOrRefuse(userDataPath)
    const result = mutate(file)
    if (result === null) {
      return null
    }
    await writeDiscordJson(discordRecordPath(userDataPath), file)
    return result
  })
}

/** One bot's record, changed in place. Null when the bot is not there, or when its entry is one this
 *  build cannot parse: rewriting that entry would lose whatever the newer build wrote. */
function updateBot(
  userDataPath: string,
  botId: string,
  mutate: (record: DiscordBotRecord) => DiscordBotRecord
): Promise<DiscordBotRecord | null> {
  return change(userDataPath, (file) => {
    const index = file.bots.findIndex((raw) => rawBotId(raw) === botId)
    if (index === -1) {
      return null
    }
    const parsed = DiscordBotRecordSchema.safeParse(file.bots[index])
    if (!parsed.success) {
      return null
    }
    const next = mutate(parsed.data)
    file.bots[index] = next
    return next
  })
}

/** Adds a bot, or updates the one already stored. `createdAt` and every field the caller left out are
 *  kept from the stored record, so a token re-paste does not reset the owner's settings. */
export async function writeDiscordBot(
  userDataPath: string,
  input: DiscordBotRecordInput
): Promise<DiscordBotRecord> {
  const record = await change(userDataPath, (file) => {
    const index = file.bots.findIndex((raw) => rawBotId(raw) === input.botId)
    const held = index === -1 ? null : DiscordBotRecordSchema.safeParse(file.bots[index])
    // An explicit `undefined` would reset a stored setting to its default, so only what was provided counts.
    const provided = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined)
    )
    const next = DiscordBotRecordSchema.parse({
      ...(held?.success ? held.data : {}),
      ...provided,
      createdAt: held?.success ? held.data.createdAt : (input.createdAt ?? Date.now())
    })
    if (index === -1) {
      file.bots.push(next)
    } else {
      file.bots[index] = next
    }
    return next
  })
  if (!record) {
    throw new Error('the bot record could not be written')
  }
  return record
}

/** Drops a bot and the token sealed for it: a record without a token is a bot that can never connect. */
export async function removeDiscordBot(userDataPath: string, botId: string): Promise<void> {
  await change(userDataPath, (file) => {
    const before = file.bots.length
    file.bots = file.bots.filter((raw) => rawBotId(raw) !== botId)
    return file.bots.length !== before ? true : null
  })
  await removeDiscordToken(userDataPath, botId)
}

/** Notes a sender the bot is not allowed to answer, newest first and once each. */
export function recordUnknownSender(
  userDataPath: string,
  botId: string,
  sender: DiscordUnknownSender
): Promise<DiscordBotRecord | null> {
  return updateBot(userDataPath, botId, (record) => ({
    ...record,
    unknownSenders: [
      { userId: sender.userId, username: sender.username },
      ...record.unknownSenders.filter((held) => held.userId !== sender.userId)
    ].slice(0, DISCORD_UNKNOWN_SENDER_LIMIT)
  }))
}

/** Clears one unknown sender, once the owner has allowed them by other means. */
export function dismissUnknownSender(
  userDataPath: string,
  botId: string,
  userId: string
): Promise<DiscordBotRecord | null> {
  return updateBot(userDataPath, botId, (record) => ({
    ...record,
    unknownSenders: record.unknownSenders.filter((held) => held.userId !== userId)
  }))
}

/** What Discord said about the token, so a listing can say "paste a new one" instead of going quiet. */
export function setTokenState(
  userDataPath: string,
  botId: string,
  tokenState: DiscordBotRecord['tokenState']
): Promise<DiscordBotRecord | null> {
  return updateBot(userDataPath, botId, (record) => ({ ...record, tokenState }))
}

/** Whether the bot answers messages in a server, or only in direct messages. */
export function setAnswerInServers(
  userDataPath: string,
  botId: string,
  answerInServers: boolean
): Promise<DiscordBotRecord | null> {
  return updateBot(userDataPath, botId, (record) => ({ ...record, answerInServers }))
}
