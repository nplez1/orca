// The ledger is a cache: corrupt, stale, or missing is never data loss, just a
// rebuild. One JSON file keyed by paneKey, written on fold completion / view
// close only — never on the status path (docs/reference/agent-status-store.md).
import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

type SessionSummaryStoreFile = { entries: Record<string, SessionSummaryStoreEntry> }

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

  constructor(private readonly filePath: string) {
    this.load()
  }

  static fromUserData(userDataPath = app.getPath('userData')): SessionSummaryStore {
    return new SessionSummaryStore(join(userDataPath, 'session-summaries.json'))
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
    this.save()
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      this.entries = isSessionSummaryStoreFile(parsed) ? parsed.entries : {}
    } catch {
      // Missing or corrupt cache: start empty; the ledger is rebuildable.
      this.entries = {}
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmpPath = `${this.filePath}.tmp`
      writeFileSync(
        tmpPath,
        JSON.stringify({ entries: this.entries } satisfies SessionSummaryStoreFile)
      )
      renameSync(tmpPath, this.filePath)
    } catch (error) {
      console.warn('[session-summary] failed to persist summary cache:', error)
    }
  }
}
