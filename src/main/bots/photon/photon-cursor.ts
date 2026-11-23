// Photon's stream cursor, kept per project and per consumer purpose. It is the handoff checkpoint, not
// the crash guard: it advances only once the message it names is durably in Orca's inbox, which is what
// keeps Photon from replaying work Orca already owns. Cursors are opaque non-negative integers that may
// contain gaps, so nothing here does arithmetic on one — a resume passes the stored value as it is.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { writeDurableSecureJsonFile } from '../../../shared/secure-storage/secure-file'
import { isMissingFileError } from '../../runtime/rpc/server/pairing/device-registry-corruption'
import { PHOTON_CONSUMER_PURPOSE, PHOTON_STREAM_START_NEW } from './photon-contract'
import type { PhotonStore } from './photon-store'

const CursorFileSchema = z.object({
  seq: z.number().int().nonnegative().safe(),
  updatedAt: z.number()
})

/** Why a cursor did not move; both are ordinary, and neither is a failure. */
export type PhotonCursorAdvance =
  | { advanced: true; seq: number }
  /** The message the cursor would cover is not in Orca's inbox yet, so advancing would lose it. */
  | { advanced: false; reason: 'not-in-inbox' }
  /** A stored cursor never moves backwards; a rewind is a bug, not a re-read. */
  | { advanced: false; reason: 'behind-stored-cursor'; stored: number }

export class PhotonCursorStore {
  constructor(
    private readonly store: PhotonStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** The cursor to resume from. Zero is a first-ever start, which Photon reads as new events only —
   *  deliberately skipping history rather than replaying an archive nobody has bounded. */
  read(projectId: string, purpose = PHOTON_CONSUMER_PURPOSE): number {
    try {
      const parsed = CursorFileSchema.safeParse(
        JSON.parse(readFileSync(this.store.cursorPath(projectId, purpose), 'utf-8'))
      )
      return parsed.success ? parsed.data.seq : PHOTON_STREAM_START_NEW
    } catch (error) {
      if (!isMissingFileError(error)) {
        console.warn('[photon] could not read a cursor; resuming as a first start', error)
      }
      return PHOTON_STREAM_START_NEW
    }
  }

  /**
   * Advances the cursor to `seq`, but only when `evidence` says the message that seq covers is already
   * in Orca's inbox. A caller that has not written the message yet gets `not-in-inbox` and the cursor
   * stays put, which is the difference between a replay and a lost message.
   */
  advance(
    projectId: string,
    seq: number,
    evidence: { inboxHas: (messageId: string) => boolean; messageId: string },
    purpose = PHOTON_CONSUMER_PURPOSE
  ): PhotonCursorAdvance {
    if (!evidence.inboxHas(evidence.messageId)) {
      return { advanced: false, reason: 'not-in-inbox' }
    }
    const stored = this.read(projectId, purpose)
    if (seq < stored) {
      return { advanced: false, reason: 'behind-stored-cursor', stored }
    }
    const path = this.store.cursorPath(projectId, purpose)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeDurableSecureJsonFile(path, { seq, updatedAt: this.now() })
    return { advanced: true, seq }
  }
}
