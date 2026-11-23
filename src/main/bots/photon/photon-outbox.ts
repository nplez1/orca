// Outbound messages that have not landed yet. A send is written here before it is attempted, so a
// failed send leaves the turn's result recorded and retried rather than vanishing, and a crash between
// the turn ending and the send going out replays instead of losing the answer. One entry per finished
// turn: the quota rule is a shape of this store, not a counter that has to be remembered.
import { z } from 'zod'
import { readPhotonJson, writePhotonJson } from './photon-files'
import type { PhotonStore } from './photon-store'

const OutboxEntry = z.object({
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
export type PhotonOutboxEntry = z.infer<typeof OutboxEntry>

const OutboxFile = z.object({
  entries: z.array(OutboxEntry).default([]),
  /** Answers Orca stopped trying to send. Kept, with the reason, so the gap is nameable. */
  dropped: z.array(OutboxEntry).default([])
})
type OutboxFile = z.infer<typeof OutboxFile>

/**
 * How long an answer is retried. **Time, not attempts**: a count is only honest if something tries
 * often enough to reach it, and the send is retried once per health tick, so twelve attempts was
 * roughly fifteen minutes of a dropped connection losing an answer to a console line. Six hours is a
 * horizon a person can be asleep through and still find their answer, and it ends rather than retries
 * forever.
 */
export const PHOTON_OUTBOX_HORIZON_MS = 6 * 60 * 60 * 1000

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

  /** A send that did not land: kept with what went wrong until the retry horizon passes, then dropped
   *  from the queue but **kept in `dropped`**, so the answer is not simply gone. Returns null when the
   *  horizon has passed, which is what the caller reports as an undelivered answer. */
  async fail(id: string, error: string): Promise<PhotonOutboxEntry | null> {
    let kept: PhotonOutboxEntry | null = null
    await this.change((file) => {
      const entries: PhotonOutboxEntry[] = []
      for (const entry of file.entries) {
        if (entry.id !== id) {
          entries.push(entry)
          continue
        }
        const attempts = entry.attempts + 1
        const firstFailedAt = entry.firstFailedAt ?? this.now()
        if (this.now() - firstFailedAt >= PHOTON_OUTBOX_HORIZON_MS) {
          console.warn(
            '[photon] giving up on an outbound message after',
            Math.round((this.now() - firstFailedAt) / 60_000),
            'minutes:',
            error
          )
          file.dropped = [
            ...file.dropped,
            { ...entry, attempts, firstFailedAt, droppedAt: this.now(), lastError: error }
          ]
          continue
        }
        kept = { ...entry, attempts, firstFailedAt, lastError: error }
        entries.push(kept)
      }
      file.entries = entries
      return true
    })
    return kept
  }

  /** The answers Orca gave up on, newest first: what a listing shows instead of a silent gap. */
  async droppedAnswers(): Promise<PhotonOutboxEntry[]> {
    await this.load()
    return [...(this.file?.dropped ?? [])].sort(
      (left, right) => (right.droppedAt ?? 0) - (left.droppedAt ?? 0)
    )
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
    this.file = { entries: [], dropped: [] }
  }

  private change(mutate: (file: OutboxFile) => boolean): Promise<void> {
    const run = this.queue.then(async () => {
      await this.load()
      const file = structuredClone(this.file ?? { entries: [], dropped: [] })
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
