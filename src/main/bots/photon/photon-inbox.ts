// Orca's inventory of what Photon delivered: one file per inbound message, written and fsynced before
// any turn starts. This is the crash guard and the dedupe index at once — replay is not exactly-once,
// so a message id Orca already handled must be a no-op rather than a second run, while a message Orca
// wrote down but never dispatched must run again on replay. That distinction is the `handledAt` mark,
// and it is the whole reason this store is separate from the cursor. Each entry carries the `seq` it
// arrived on, so the entries with no `handledAt` can be replayed in order after a crash without waiting
// for Photon to redeliver them.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { PhotonInboundMessageSchema, type PhotonInboundMessage } from './photon-contract'
import { listPhotonDir, readPhotonJson, writePhotonJson } from './photon-files'
import { photonPathSegmentId } from './photon-store-paths'
import type { PhotonStore } from './photon-store'

const InboxEntrySchema = lazyZodSchema(() =>
  z.object({
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
    handledAt: z.number().optional(),
    /** How many times a dispatch has been attempted and failed, and when the first one was: the horizon is
     *  measured from the clock, so a restart cannot restart it either. */
    attempts: z.number().int().nonnegative().default(0),
    firstFailedAt: z.number().optional(),
    /** Set when Orca gave up: the message is kept, named, and out of the stream's way. */
    parkedAt: z.number().optional(),
    parkedReason: z.string().optional()
  })
)
export type PhotonInboxEntry = z.infer<typeof InboxEntrySchema>

/** What a caller should do with a delivery it just claimed. */
export type PhotonInboxClaim =
  /** Orca had never seen this message, or saw it but never dispatched it: the caller owns the turn. */
  | { action: 'run'; entry: PhotonInboxEntry }
  /** Orca already handled it: a replay, and running it again would be the double-run this store stops. */
  | { action: 'skip'; entry: PhotonInboxEntry }

/**
 * How long one message may keep failing before Orca parks it.
 *
 * **Time, not a count.** The stream resumes with a 1 s, 2 s, 4 s … backoff, and at startup `replayPending`
 * and the stream's own replay can each consume an attempt on one entry back to back — so a budget of three
 * attempts was about three *seconds* of a provider blip, which parked a message that would have been
 * delivered a moment later. A parked entry is marked handled, so nothing replays it and the person's text
 * is never answered: "never loses a message it acked" needs a horizon measured in the failure, not in
 * ticks. The outbox already made this choice for the same reason.
 */
export const PHOTON_INBOX_PARK_HORIZON_MS = 15 * 60 * 1000

/** Message ids become file names, so anything that could escape the directory is refused. */
// `%` is legal in an id: it is encoded to `%25` on disk, so an id that contains one round-trips. The
// rest of the set keeps a path traversal out, which is what this guard is for.
const SAFE_ID = /^[A-Za-z0-9._:%-]{1,200}$/

// A digest stands in for an id that cannot be a file name, so nothing a provider sends can fail to be
// stored. The entry keeps the real id, which is what dedupe and the cursor match on.
const DIGEST_ID_PREFIX = 'sha256-'

export function photonInboxIdIsSafe(messageId: string): boolean {
  return SAFE_ID.test(messageId) && messageId !== '.' && messageId !== '..'
}

/**
 * The name an entry is stored under.
 *
 * Why a digest rather than a refusal: `claim` used to throw on an id outside the safe alphabet, and
 * that throw ran before the handler's own park-and-advance path — so one such id stopped the stream,
 * replayed the same frame on every resume, and queued every later message behind it with nothing
 * recorded to explain why. A storable id keeps its own name, so nothing already on disk moves.
 */
function inboxKey(messageId: string): string {
  return photonInboxIdIsSafe(messageId)
    ? messageId
    : `${DIGEST_ID_PREFIX}${createHash('sha256').update(messageId).digest('hex')}`
}

export class PhotonInbox {
  private readonly seen = new Map<string, Promise<Set<string>>>()
  /** One claim at a time per project, so two deliveries of one message cannot both see "unseen". */
  private readonly queue = new Map<string, Promise<void>>()

  constructor(
    private readonly store: PhotonStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Takes a message into Orca's store, or reports that Orca already handled it. The write is durable
   * and happens before the caller starts anything, which is the point of the store; `markHandled` is
   * what the caller says afterwards.
   */
  async claim(
    projectId: string,
    message: PhotonInboundMessage,
    seq?: number
  ): Promise<PhotonInboxClaim> {
    return this.serialise(projectId, async () => {
      const held = await this.read(projectId, message.id)
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
        receivedAt: this.now(),
        attempts: 0
      }
      await this.write(entry)
      return { action: 'run', entry }
    })
  }

  /** Records that the message is dealt with — dispatched to a turn, or deliberately not acted on.
   *  Without this a replay would run the same turn again. */
  async markHandled(projectId: string, messageId: string): Promise<void> {
    const held = await this.read(projectId, messageId)
    if (!held || held.handledAt !== undefined) {
      return
    }
    await this.write({ ...held, handledAt: this.now() })
  }

  /** Counts a failed dispatch, durably and before the retry: a crash mid-retry must not reset the count
   *  and leave the message replaying for good. Returns how long it has been failing, which is the number
   *  the horizon is measured against. */
  async recordAttempt(projectId: string, messageId: string): Promise<number> {
    const held = await this.read(projectId, messageId)
    if (!held) {
      return 0
    }
    const firstFailedAt = held.firstFailedAt ?? this.now()
    await this.write({ ...held, attempts: held.attempts + 1, firstFailedAt })
    return this.now() - firstFailedAt
  }

  /** Gives up on one message: kept on disk, named, and marked handled so the cursor may pass it. This is
   *  the declared terminal outcome a message needs when nothing can deliver it — without it the entry
   *  stays unhandled, `blocked-by-unhandled` stops the cursor, and every later message queues behind one
   *  that will never be dealt with. */
  async park(
    projectId: string,
    messageId: string,
    reason: string
  ): Promise<PhotonInboxEntry | null> {
    const held = await this.read(projectId, messageId)
    if (!held) {
      return null
    }
    const parked: PhotonInboxEntry = {
      ...held,
      handledAt: held.handledAt ?? this.now(),
      parkedAt: this.now(),
      parkedReason: reason
    }
    await this.write(parked)
    return parked
  }

  /** The messages Orca gave up on, newest first. */
  async parked(projectId: string): Promise<PhotonInboxEntry[]> {
    const parked: PhotonInboxEntry[] = []
    for (const messageId of await this.idsOf(projectId)) {
      const entry = await this.read(projectId, messageId)
      if (entry?.parkedAt !== undefined) {
        parked.push(entry)
      }
    }
    return parked.sort((left, right) => (right.parkedAt ?? 0) - (left.parkedAt ?? 0))
  }

  /**
   * Gives every parked message another chance, and says how many. A parked entry is marked handled, so
   * `unhandled()` skips it and nothing else would ever replay it: without a route back the route is "an
   * acked message that is never answered". Startup is where it belongs, because a restart is exactly when
   * what made it fail may have changed — the runtime is up, the chat exists again. The horizon restarts
   * with it, so a message that keeps failing parks again rather than replaying on every read.
   */
  async unpark(projectId: string): Promise<number> {
    const parked = await this.parked(projectId)
    for (const entry of parked) {
      const { handledAt: _handled, parkedAt: _parked, parkedReason: _why, ...rest } = entry
      await this.write({ ...rest, attempts: 0, firstFailedAt: undefined })
    }
    return parked.length
  }

  async has(projectId: string, messageId: string): Promise<boolean> {
    return (await this.idsOf(projectId)).has(inboxKey(messageId))
  }

  async read(projectId: string, messageId: string): Promise<PhotonInboxEntry | null> {
    const key = inboxKey(messageId)
    if (!(await this.has(projectId, key))) {
      return null
    }
    const read = await readPhotonJson(this.store.inboxPath(projectId, key), 'inbox entry')
    if (read.kind === 'missing') {
      ;(await this.idsOf(projectId)).delete(key)
      return null
    }
    if (read.kind === 'unreadable') {
      return null
    }
    const parsed = InboxEntrySchema.safeParse(read.value)
    return parsed.success ? parsed.data : null
  }

  async ids(projectId: string): Promise<string[]> {
    return [...(await this.idsOf(projectId))]
  }

  /** Every entry Orca wrote down and never dealt with, oldest stream position first. This is what a
   *  restart replays: without it, a message whose dispatch never happened depends on Photon choosing
   *  to redeliver it, which replay is not obligated to do. */
  async unhandled(projectId: string): Promise<PhotonInboxEntry[]> {
    const entries: PhotonInboxEntry[] = []
    for (const messageId of await this.idsOf(projectId)) {
      const entry = await this.read(projectId, messageId)
      if (entry && entry.handledAt === undefined) {
        entries.push(entry)
      }
    }
    return entries.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
  }

  /** The oldest entry at or below `seq` that Orca never dealt with, ignoring `except`. The cursor may
   *  not move past one of these: Photon only replays after the highest cursor it was given, so a cursor
   *  that stepped over an unhandled message would make it unreachable. */
  async unhandledAtOrBelow(projectId: string, seq: number, except: string): Promise<string | null> {
    const found = (await this.unhandled(projectId)).find(
      (entry) => entry.messageId !== except && (entry.seq ?? Number.POSITIVE_INFINITY) <= seq
    )
    return found?.messageId ?? null
  }

  private async write(entry: PhotonInboxEntry): Promise<void> {
    const key = inboxKey(entry.messageId)
    await writePhotonJson(this.store.inboxPath(entry.projectId, key), entry)
    ;(await this.idsOf(entry.projectId)).add(key)
  }

  /** One claim at a time per project: the file listing it consults is per project too. */
  private serialise<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(projectId) ?? Promise.resolve()
    const run = previous.then(work, work)
    this.queue.set(
      projectId,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }

  private idsOf(projectId: string): Promise<Set<string>> {
    const cached = this.seen.get(projectId)
    if (cached) {
      return cached
    }
    const listing = this.list(projectId)
    this.seen.set(projectId, listing)
    return listing
  }

  private async list(projectId: string): Promise<Set<string>> {
    const ids = new Set<string>()
    for (const name of await listPhotonDir(this.store.inboxDir(projectId))) {
      if (name.endsWith('.json')) {
        // Decoded, so the set holds the ids the rest of this class is handed. The file name carries an
        // encoded id (a `:` in a name is an alternate data stream on NTFS); leaving it encoded made
        // `has(rawId)` false after a restart, which stuck the cursor at that message for good.
        ids.add(photonPathSegmentId(name.slice(0, -'.json'.length)))
      }
    }
    return ids
  }
}
