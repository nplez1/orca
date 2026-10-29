// The ledger is a cache: corrupt, stale, or missing is never data loss, just a
// rebuild. One JSON file keyed by paneKey, written on fold completion / view
// close only — never on the status path (docs/reference/agent-status-store.md).
//
// Electron-free: a paired Orca host serves this store too, so the path is always
// passed in rather than resolved from `app`.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import type {
  SessionSummaryLedger,
  SessionSummaryLedgerDelta
} from '../../shared/session-summary-types'

export type SessionSummaryStoreEntry = {
  /** Transcript identity this ledger folds; a change resets the ledger. */
  identity: { providerSessionId: string | null; transcriptPath: string | null }
  ledger: SessionSummaryLedger
  /** Completed chunk extracts not yet folded in; keys are `<from>-<to>` message ranges. */
  chunkCache: Record<string, SessionSummaryLedgerDelta>
  /** Transcript message count at last read; seeds the skeleton's backlog hint. */
  messageCount: number
  seenThrough: number
  updatedAt: number
}

const MAX_ENTRIES = 200

/** How long a change may sit in memory before it is written; a pane close is not an emergency. */
const SAVE_DEBOUNCE_MS = 1_000

// One exit hook for every store with a queued write: `set` runs on the main thread, and a quit inside
// the debounce window would otherwise drop the fold the user just paid a model call for.
const storesWithQueuedWrites = new Set<SessionSummaryStore>()
let exitFlushRegistered = false

function registerExitFlush(): void {
  if (exitFlushRegistered) {
    return
  }
  exitFlushRegistered = true
  process.once('exit', () => {
    for (const store of storesWithQueuedWrites) {
      store.flush()
    }
    storesWithQueuedWrites.clear()
  })
}

/**
 * Bumped when a ledger's *shape* changes, so every cached ledger is discarded and folded again.
 *
 * v2: facts carry the transcript index they came from (`SessionSummaryFact`), which is what the
 * pane's "since your last message" window is computed from. A v1 ledger has no indexes, so it
 * cannot answer that question and is worth less than one re-fold.
 */
const STORE_VERSION = 2

type SessionSummaryStoreFile = {
  version?: number
  entries: Record<string, SessionSummaryStoreEntry>
}

// Values are unvalidated on purpose: this is a rebuildable cache, and a bad
// entry surfaces as an empty ledger rather than a load failure.
function isSessionSummaryStoreFile(value: unknown): value is SessionSummaryStoreFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'entries' in value &&
    typeof value.entries === 'object' &&
    value.entries !== null
  )
}

export class SessionSummaryStore {
  private entries: Record<string, SessionSummaryStoreEntry> = {}
  private saveTimer: NodeJS.Timeout | null = null
  private queued = false

  constructor(private readonly filePath: string) {
    this.load()
  }

  get(paneKey: string): SessionSummaryStoreEntry | null {
    return this.entries[paneKey] ?? null
  }

  set(paneKey: string, entry: SessionSummaryStoreEntry): void {
    this.entries[paneKey] = entry
    const keys = Object.keys(this.entries)
    if (keys.length > MAX_ENTRIES) {
      const evictable = keys
        .filter((key) => key !== paneKey)
        .sort((a, b) => this.entries[a].updatedAt - this.entries[b].updatedAt)
      for (const key of evictable.slice(0, keys.length - MAX_ENTRIES)) {
        delete this.entries[key]
      }
    }
    this.scheduleSave()
  }

  /** Drops a pane's cache entirely — a new session took the pane, or it never folded. */
  delete(paneKey: string): void {
    if (!(paneKey in this.entries)) {
      return
    }
    delete this.entries[paneKey]
    this.scheduleSave()
  }

  /** Write a queued change now. Quit paths and tests that reopen the file call this. */
  flush(): void {
    if (!this.queued) {
      return
    }
    this.clearTimer()
    this.queued = false
    storesWithQueuedWrites.delete(this)
    this.save()
  }

  private scheduleSave(): void {
    this.queued = true
    storesWithQueuedWrites.add(this)
    registerExitFlush()
    if (this.saveTimer) {
      return
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, SAVE_DEBOUNCE_MS)
    // A pending cache write must not be what keeps a quitting process alive.
    this.saveTimer.unref?.()
  }

  private clearTimer(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (!isSessionSummaryStoreFile(parsed)) {
        this.entries = {}
        return
      }
      // Why drop rather than migrate: this is a rebuildable cache, so one fold per session
      // costs less than a migration path that has to stay correct forever.
      this.entries = parsed.version === STORE_VERSION ? parsed.entries : {}
    } catch {
      // Missing or corrupt cache: start empty; the ledger is rebuildable.
      this.entries = {}
    }
  }

  private save(): void {
    try {
      // Why skip a vanished directory: a headless host's own store can be flushed by the exit hook after
      // its directory is gone, and recreating it would leave an empty cache behind.
      if (!existsSync(dirname(this.filePath))) {
        return
      }
      mkdirSync(dirname(this.filePath), { recursive: true })
      // Why a per-writer temp name: a paired host serves this store too, and one fixed `.tmp` name
      // meant two writers published each other's file. The durable helper fsyncs before the rename.
      writeFileDurableSync(
        durableWriteTempPath(this.filePath),
        this.filePath,
        JSON.stringify({
          version: STORE_VERSION,
          entries: this.entries
        } satisfies SessionSummaryStoreFile)
      )
    } catch (error) {
      console.warn('[session-summary] failed to persist summary cache:', error)
    }
  }
}
