// Outbound messages that have not landed yet. A send is written here before it is attempted, so a
// failed send leaves the turn's result recorded and retried rather than vanishing, and a crash between
// the turn ending and the send going out replays instead of losing the answer. One entry per finished
// turn: the quota rule is a shape of this store, not a counter that has to be remembered.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { writeDurableSecureJsonFile } from '../../../shared/secure-storage/secure-file'
import { isMissingFileError } from '../../runtime/rpc/server/pairing/device-registry-corruption'
import type { PhotonStore } from './photon-store'

const OutboxEntry = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
  body: z.string(),
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

  constructor(
    private readonly store: PhotonStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  get path(): string {
    return this.store.outboxPath()
  }

  entries(): PhotonOutboxEntry[] {
    return this.read().entries
  }

  pendingFor(botId: string): PhotonOutboxEntry[] {
    return this.entries().filter((entry) => entry.botId === botId)
  }

  /** Records a send before it is attempted. Re-enqueuing the same id is a no-op, so a retry that races
   *  a replay cannot double-send. */
  enqueue(entry: Omit<PhotonOutboxEntry, 'createdAt' | 'attempts'>): PhotonOutboxEntry {
    const file = this.read()
    const existing = file.entries.find((candidate) => candidate.id === entry.id)
    if (existing) {
      return existing
    }
    const saved: PhotonOutboxEntry = { ...entry, createdAt: this.now(), attempts: 0 }
    this.write({ entries: [...file.entries, saved] })
    return saved
  }

  /** A send that landed: gone from here, so nothing retries it. */
  settle(id: string): void {
    const file = this.read()
    this.write({ entries: file.entries.filter((entry) => entry.id !== id) })
  }

  /** A send that did not land: kept with what went wrong, until it runs out of attempts. */
  fail(id: string, error: string): PhotonOutboxEntry | null {
    const file = this.read()
    let kept: PhotonOutboxEntry | null = null
    const entries: PhotonOutboxEntry[] = []
    for (const entry of file.entries) {
      if (entry.id !== id) {
        entries.push(entry)
        continue
      }
      const attempts = entry.attempts + 1
      if (attempts >= PHOTON_OUTBOX_MAX_ATTEMPTS) {
        console.warn('[photon] dropping an outbound message after', attempts, 'attempts:', error)
        continue
      }
      kept = { ...entry, attempts, lastError: error }
      entries.push(kept)
    }
    this.write({ entries })
    return kept
  }

  /** Drops everything for a bot whose record is going away. */
  forget(botId: string): void {
    const file = this.read()
    this.write({ entries: file.entries.filter((entry) => entry.botId !== botId) })
  }

  private read(): OutboxFile {
    if (this.file) {
      return this.file
    }
    let file: OutboxFile = { entries: [] }
    try {
      const parsed = OutboxFile.safeParse(JSON.parse(readFileSync(this.path, 'utf-8')))
      if (parsed.success) {
        file = parsed.data
      } else {
        console.warn('[photon] the outbox is unreadable; starting empty', parsed.error.issues)
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        console.warn('[photon] could not read the outbox', error)
      }
    }
    this.file = file
    return file
  }

  private write(file: OutboxFile): void {
    this.file = file
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeDurableSecureJsonFile(this.path, file)
  }
}
