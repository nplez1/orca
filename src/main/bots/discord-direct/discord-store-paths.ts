// Where the direct Discord channel's files live, and the one rule about them that matters: every provider
// id becomes a path segment, so an id that could escape its directory is refused rather than joined.
import { join } from 'node:path'

export const DISCORD_DIR = 'local-discord'
export const DISCORD_RECORD_FILE = 'discord.json'
export const DISCORD_SECRETS_FILE = 'discord-secrets.json'
export const DISCORD_OUTBOX_FILE = 'discord-outbox.json'

/**
 * One path segment built from a provider id.
 *
 * A `:` is **encoded**, not refused: on NTFS `a:b.json` opens an alternate data stream that `readdir`
 * never lists, so the file would be written somewhere the store cannot find again. Discord's ids are
 * snowflakes, but a message id arrives from the wire, so the guard refuses what a path cannot carry
 * rather than assuming the alphabet. Percent-encoding is reversible and `%` is encoded first, so two ids
 * can never collide on one name.
 */
export function discordPathSegment(id: string): string {
  if (!/^[A-Za-z0-9._:%-]{1,400}$/.test(id) || id === '.' || id === '..') {
    throw new Error(`Discord id is not usable as a path segment: ${id.slice(0, 80)}`)
  }
  return id.replaceAll('%', '%25').replaceAll(':', '%3A')
}

/** A file name back to the id it was made from: decoded in the opposite order, so a literal `%` written
 *  as `%25` survives the round trip. */
export function discordPathSegmentId(segment: string): string {
  return segment.replaceAll('%3A', ':').replaceAll('%25', '%')
}

const inDir = (userDataPath: string, ...parts: string[]): string =>
  join(userDataPath, DISCORD_DIR, ...parts)

export const discordRecordPath = (userDataPath: string): string =>
  inDir(userDataPath, DISCORD_RECORD_FILE)

export const discordSecretsPath = (userDataPath: string): string =>
  inDir(userDataPath, DISCORD_SECRETS_FILE)

export const discordOutboxPath = (userDataPath: string): string =>
  inDir(userDataPath, DISCORD_OUTBOX_FILE)

export const discordInboxDir = (userDataPath: string, botId: string): string =>
  inDir(userDataPath, 'inbox', discordPathSegment(botId))

export const discordInboxPath = (userDataPath: string, botId: string, messageId: string): string =>
  join(discordInboxDir(userDataPath, botId), `${discordPathSegment(messageId)}.json`)

export const discordThreadPath = (userDataPath: string, botId: string): string =>
  inDir(userDataPath, 'threads', `${discordPathSegment(botId)}.json`)
