// Outbound messages that have not landed yet. A send is written here before it is attempted, so a
// failed send leaves the turn's result recorded and retried rather than vanishing, and a crash between
// the turn ending and the send going out replays instead of losing the answer. One entry per finished
// turn: the quota rule is a shape of this store, not a counter that has to be remembered.
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { readPhotonJson, writePhotonJson } from './photon-files'
import type { PhotonStore } from './photon-store'

const OutboxEntry = lazyZodSchema(() =>
  z.object({
    id: z.string().min(1),
    botId: z.string().min(1),
    projectId: z.string().min(1),
    conversationId: z.string().min(1),
    body: z.string(),
    /** Whether the answer was cut to fit one message, which the retry line reports rather than hiding. */
    truncated: z.boolean().default(false),
    createdAt: z.number(),
    attempts: z.number().int().nonnegative().default(0),
    /** When the first attempt failed: the retry horizon is measured from here, not from a count. */
    firstFailedAt: z.number().optional(),
    lastError: z.string().optional(),
    /** Set when Orca stopped trying: the answer is kept, named, and no longer retried. */
    droppedAt: z.number().optional()
  })
)
export type PhotonOutboxEntry = z.infer<typeof OutboxEntry>

const OutboxFile = lazyZodSchema(() => z.object({ entries: z.array(OutboxEntry).default([]) }))
type OutboxFile = z.infer<typeof OutboxFile>

/**
 * How long an answer is retried. **Time, not attempts**: a count is only honest if something tries
 * often enough to reach it, and the send is retried once per health tick, so twelve attempts was
 * roughly fifteen minutes of a dropped connection losing an answer to a console line. Six hours is a
 * horizon a person can be asleep through and still find their answer.
 *
 * What is kept when it ends, and what is not: the **count and the last reason** go on the bot's record
 * (`undeliveredAnswerCount`, `lastUndeliveredReason`) and are shown by `bots.photon.status`, so the owner
 * can see that someone is owed a reply. The body itself is **not** retained — it belongs to a conversation
 * with a person, an unbounded array of them outlives the bot, and a count is what a status can honestly
 * carry.
 */
export const PHOTON_OUTBOX_HORIZON_MS = 6 * 60 * 60 * 1000

/** What `fail` found: still queued, ended by this call, or no longer there at all. */
export type PhotonOutboxFail =
  | { kind: 'kept'; entry: PhotonOutboxEntry }
  | { kind: 'dropped'; entry: PhotonOutboxEntry }
  | { kind: 'gone' }

export class PhotonOutbox {
  private file: OutboxFile | null = null
  private loading: Promise<void> | null = null
  /** One change at a time, so a settle cannot write over a concurrent fail. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: PhotonStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  get path(): string {
    return this.store.outboxPath()
  }

  async entries(): Promise<PhotonOutboxEntry[]> {
    await this.load()
    return this.file?.entries ?? []
  }

  async pendingFor(botId: string): Promise<PhotonOutboxEntry[]> {
    return (await this.entries()).filter((entry) => entry.botId === botId)
  }

  /** Records a send before it is attempted. Re-enqueuing the same id is a no-op, so a retry that races
   *  a replay cannot double-send. */
  async enqueue(
    entry: Omit<PhotonOutboxEntry, 'createdAt' | 'attempts' | 'truncated'> & { truncated?: boolean }
  ): Promise<PhotonOutboxEntry> {
    let saved: PhotonOutboxEntry | null = null
    await this.change((file) => {
      const existing = file.entries.find((candidate) => candidate.id === entry.id)
      if (existing) {
        saved = existing
        return false
      }
      saved = {
        ...entry,
        createdAt: this.now(),
        attempts: 0,
        truncated: entry.truncated ?? false
      }
      file.entries.push(saved)
      return true
    })
    if (!saved) {
      throw new Error('a send could not be recorded in the outbox')
    }
    return saved
  }

  /** A send that landed: gone from here, so nothing retries it. */
  async settle(id: string): Promise<void> {
    await this.change((file) => {
      const before = file.entries.length
      file.entries = file.entries.filter((entry) => entry.id !== id)
      return file.entries.length !== before
    })
  }

  /**
   * A send that did not land. Three answers, because the caller has three different things to say and
   * conflating them told the owner someone was owed a reply that had in fact been delivered:
   *
   * - `kept`: still inside the horizon, so it stays queued and the next tick retries it.
   * - `dropped`: the horizon passed and this call is what ended it — the only case worth reporting.
   * - `gone`: the entry is no longer queued. A concurrent attempt settled it, or `forget()` removed it
   *   with its bot. Nothing to report: the answer either landed or was deliberately discarded.
   */
  async fail(id: string, error: string): Promise<PhotonOutboxFail> {
    let outcome: PhotonOutboxFail = { kind: 'gone' }
    await this.change((file) => {
      const entries: PhotonOutboxEntry[] = []
      let found = false
      for (const entry of file.entries) {
        if (entry.id !== id) {
          entries.push(entry)
          continue
        }
        found = true
        const attempts = entry.attempts + 1
        const firstFailedAt = entry.firstFailedAt ?? this.now()
        if (this.now() - firstFailedAt >= PHOTON_OUTBOX_HORIZON_MS) {
          // Counted and named on the record; the body is not kept, so nothing here grows with the bot's
          // history and `forget()` has no extra array to filter.
          console.warn(
            '[photon] giving up on an outbound message after',
            Math.round((this.now() - firstFailedAt) / 60_000),
            'minutes:',
            error
          )
          outcome = {
            kind: 'dropped',
            entry: { ...entry, attempts, firstFailedAt, droppedAt: this.now(), lastError: error }
          }
          continue
        }
        const kept = { ...entry, attempts, firstFailedAt, lastError: error }
        outcome = { kind: 'kept', entry: kept }
        entries.push(kept)
      }
      file.entries = entries
      return found
    })
    return outcome
  }

  /** Drops everything for a bot whose record is going away. */
  async forget(botId: string): Promise<void> {
    await this.change((file) => {
      const before = file.entries.length
      file.entries = file.entries.filter((entry) => entry.botId !== botId)
      return file.entries.length !== before
    })
  }

  private async load(): Promise<void> {
    this.loading ??= this.read()
    await this.loading
  }

  private async read(): Promise<void> {
    if (this.file) {
      return
    }
    const read = await readPhotonJson(this.path, 'outbox')
    if (read.kind === 'parsed') {
      const parsed = OutboxFile.safeParse(read.value)
      if (parsed.success) {
        this.file = parsed.data
        return
      }
      console.warn('[photon] the outbox is unreadable; starting empty', parsed.error.issues)
    }
    this.file = { entries: [] }
  }

  private change(mutate: (file: OutboxFile) => boolean): Promise<void> {
    const run = this.queue.then(async () => {
      await this.load()
      const file = structuredClone(this.file ?? { entries: [] })
      if (!mutate(file)) {
        return
      }
      this.file = file
      await writePhotonJson(this.path, file)
    })
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
