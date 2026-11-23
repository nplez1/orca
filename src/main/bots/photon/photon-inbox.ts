// Orca's inventory of what Photon delivered: one file per inbound message, written and fsynced before
// any turn starts. This is the crash guard and the dedupe index at once — replay is not exactly-once,
// so a message id Orca already handled must be a no-op rather than a second run, while a message Orca
// wrote down but never dispatched must run again on replay. That distinction is the `handledAt` mark,
// and it is the whole reason this store is separate from the cursor. Each entry carries the `seq` it
// arrived on, so the entries with no `handledAt` can be replayed in order after a crash without waiting
// for Photon to redeliver them.
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { writeDurableSecureJsonFile } from '../../../shared/secure-storage/secure-file'
import { isMissingFileError } from '../../runtime/rpc/server/pairing/device-registry-corruption'
import { PhotonInboundMessageSchema, type PhotonInboundMessage } from './photon-contract'
import type { PhotonStore } from './photon-store'

const InboxEntrySchema = z.object({
  messageId: z.string().min(1),
  /** The stream position it arrived on. Kept so an unhandled entry can be replayed and its cursor
   *  advanced without Photon redelivering it. */
  seq: z.number().int().nonnegative().safe().optional(),
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
  sender: PhotonInboundMessageSchema.shape.sender,
  text: z.string(),
  createdAt: z.number(),
  /** When Orca took it, which is what the turn's transcript says rather than the sender's clock. */
  receivedAt: z.number(),
  /** Set once the message has been dispatched to a turn or deliberately ignored. Absent means a crash
   *  landed between the write and the dispatch, so a replay must run it. */
  handledAt: z.number().optional()
})
export type PhotonInboxEntry = z.infer<typeof InboxEntrySchema>

/** What a caller should do with a delivery it just claimed. */
export type PhotonInboxClaim =
  /** Orca had never seen this message, or saw it but never dispatched it: the caller owns the turn. */
  | { action: 'run'; entry: PhotonInboxEntry }
  /** Orca already handled it: a replay, and running it again would be the double-run this store stops. */
  | { action: 'skip'; entry: PhotonInboxEntry }

/** Message ids become file names, so anything that could escape the directory is refused. */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/

export function photonInboxIdIsSafe(messageId: string): boolean {
  return SAFE_ID.test(messageId) && messageId !== '.' && messageId !== '..'
}

export class PhotonInbox {
  private readonly seen = new Map<string, Set<string>>()

  constructor(
    private readonly store: PhotonStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Takes a message into Orca's store, or reports that Orca already handled it. The write is durable
   * and happens before the caller starts anything, which is the point of the store; `markHandled` is
   * what the caller says afterwards.
   */
  claim(projectId: string, message: PhotonInboundMessage, seq?: number): PhotonInboxClaim {
    if (!photonInboxIdIsSafe(message.id)) {
      throw new Error(`Photon message id is not usable as a file name: ${message.id.slice(0, 80)}`)
    }
    const held = this.read(projectId, message.id)
    if (held) {
      return { action: held.handledAt === undefined ? 'run' : 'skip', entry: held }
    }
    const entry: PhotonInboxEntry = {
      messageId: message.id,
      ...(seq === undefined ? {} : { seq }),
      projectId,
      conversationId: message.conversationId,
      sender: message.sender,
      text: message.text,
      createdAt: message.createdAt,
      receivedAt: this.now()
    }
    this.write(entry)
    return { action: 'run', entry }
  }

  /** Records that the message is dealt with — dispatched to a turn, or deliberately not acted on.
   *  Without this a replay would run the same turn again. */
  markHandled(projectId: string, messageId: string): void {
    const held = this.read(projectId, messageId)
    if (!held || held.handledAt !== undefined) {
      return
    }
    this.write({ ...held, handledAt: this.now() })
  }

  has(projectId: string, messageId: string): boolean {
    return this.idsOf(projectId).has(messageId)
  }

  read(projectId: string, messageId: string): PhotonInboxEntry | null {
    if (!this.has(projectId, messageId)) {
      return null
    }
    try {
      const parsed = InboxEntrySchema.safeParse(
        JSON.parse(readFileSync(this.store.inboxPath(projectId, messageId), 'utf-8'))
      )
      return parsed.success ? parsed.data : null
    } catch (error) {
      if (isMissingFileError(error)) {
        this.idsOf(projectId).delete(messageId)
        return null
      }
      console.warn('[photon] could not read an inbox entry', error)
      return null
    }
  }

  /** The conversation a message arrived on, for the send path: a reply rides the conversation the
   *  inbound message opened, and a conversation absent from here is never addressed. */
  conversationOf(projectId: string, messageId: string): string | null {
    return this.read(projectId, messageId)?.conversationId ?? null
  }

  ids(projectId: string): string[] {
    return [...this.idsOf(projectId)]
  }

  /** Every entry Orca wrote down and never dealt with, oldest stream position first. This is what a
   *  restart replays: without it, a message whose dispatch never happened depends on Photon choosing
   *  to redeliver it, which replay is not obligated to do. */
  unhandled(projectId: string): PhotonInboxEntry[] {
    const entries: PhotonInboxEntry[] = []
    for (const messageId of this.idsOf(projectId)) {
      const entry = this.read(projectId, messageId)
      if (entry && entry.handledAt === undefined) {
        entries.push(entry)
      }
    }
    return entries.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
  }

  /** The oldest entry at or below `seq` that Orca never dealt with, ignoring `except`. The cursor may
   *  not move past one of these: Photon only replays after the highest cursor it was given, so a cursor
   *  that stepped over an unhandled message would make it unreachable. */
  unhandledAtOrBelow(projectId: string, seq: number, except: string): string | null {
    const found = this.unhandled(projectId).find(
      (entry) => entry.messageId !== except && (entry.seq ?? Number.POSITIVE_INFINITY) <= seq
    )
    return found?.messageId ?? null
  }

  private write(entry: PhotonInboxEntry): void {
    mkdirSync(this.store.inboxDir(entry.projectId), { recursive: true, mode: 0o700 })
    writeDurableSecureJsonFile(this.store.inboxPath(entry.projectId, entry.messageId), entry)
    this.idsOf(entry.projectId).add(entry.messageId)
  }

  private idsOf(projectId: string): Set<string> {
    const cached = this.seen.get(projectId)
    if (cached) {
      return cached
    }
    const ids = new Set<string>()
    try {
      for (const name of readdirSync(this.store.inboxDir(projectId))) {
        if (name.endsWith('.json')) {
          ids.add(name.slice(0, -'.json'.length))
        }
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        console.warn('[photon] could not list a project inbox', error)
      }
    }
    this.seen.set(projectId, ids)
    return ids
  }
}
