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
  lastError: z.string().optional()
})
export type PhotonOutboxEntry = z.infer<typeof OutboxEntry>

const OutboxFile = z.object({ entries: z.array(OutboxEntry).default([]) })
type OutboxFile = z.infer<typeof OutboxFile>

/** Beyond this a pending send is dropped rather than retried forever: an answer to a conversation
 *  nobody is waiting on any more is worse than a logged gap. */
export const PHOTON_OUTBOX_MAX_ATTEMPTS = 12

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

  /** A send that did not land: kept with what went wrong, until it runs out of attempts. */
  async fail(id: string, error: string): Promise<PhotonOutboxEntry | null> {
    let kept: PhotonOutboxEntry | null = null
    await this.change((file) => {
      const entries: PhotonOutboxEntry[] = []
      let dropped = 0
      for (const entry of file.entries) {
        if (entry.id !== id) {
          entries.push(entry)
          continue
        }
        const attempts = entry.attempts + 1
        if (attempts >= PHOTON_OUTBOX_MAX_ATTEMPTS) {
          console.warn('[photon] dropping an outbound message after', attempts, 'attempts:', error)
          dropped += 1
          continue
        }
        kept = { ...entry, attempts, lastError: error }
        entries.push(kept)
      }
      file.entries = entries
      return dropped > 0 || entries.some((entry) => entry.id === id)
    })
    return kept
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
