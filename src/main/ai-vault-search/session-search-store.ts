/* eslint-disable max-lines -- Why: upstream-owned and at its budget; the fork's 35-code-line delta rides inside it, and splitting costs a permanent sync hunk. */
import type SyncDatabase from '../sqlite/sync-database'
import { asRecord } from '../ai-vault/session-scanner-record-value'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { TranscriptSessionIdentity } from '../ai-vault/session-transcript-consumers'
import {
  fileIdentity,
  type SessionSearchFileIdentity,
  type SessionSearchIndexedFile
} from './session-search-file-cursor'
import {
  SESSION_SEARCH_COMMIT_CHARS,
  SessionSearchIndexWriter,
  type SessionSearchFileWrite
} from './session-search-index-writer'
import { deleteExpiredSearchFiles, drainOrphanedMessages } from './session-search-retention-delete'
import { openSessionSearchDatabase } from './session-search-schema'

/** Due files need a full reread; failed reads track counts and mtime to bound retries. */
export type SessionSearchFileState = 'current' | 'due' | 'failed'

export type SessionSearchFileRow = {
  path: string
  identity: SessionSearchFileIdentity
  mtimeMs: number
  sizeBytes: number | null
  state: SessionSearchFileState
  failCount: number
  failedMtimeMs: number | null
}

export type SessionSearchResumableCursor = { byteOffset: number; prefixHash: string }

export type SessionSearchStateCounts = {
  current: number
  due: number
  failed: number
  /** Session counts distinguish indexed content from files that have only been discovered. */
  sessionsByAgent: Record<string, number>
  messages: number
}

export class SessionSearchStore {
  private readonly db: SyncDatabase
  private readonly writer: SessionSearchIndexWriter
  private closed = false
  private retentionCutoffMs: number | null = null
  // Coalesce replacements into one drain, rerunning if more rows become orphaned.
  private draining = false
  private drainRequested = false

  constructor(
    path: string,
    private readonly onError: (error: unknown) => void = (error) =>
      console.warn(
        '[ai-vault-search] index write failed:',
        error instanceof Error ? error.name : 'IndexError'
      ),
    /** The content tier; see SessionSearchIndexWriter's constructor for why it defaults on. */
    storeContent = true
  ) {
    this.db = openSessionSearchDatabase(path)
    // Why here and not at the caller: which tier the rows were decoded under is a
    // fact about the rows, so the store is what keeps it true across a consent change.
    if (storeContent && !this.contentRowsIndexed()) {
      this.adoptContentTier()
    }
    this.writer = new SessionSearchIndexWriter(
      this.db,
      SESSION_SEARCH_COMMIT_CHARS,
      () => this.scheduleOrphanDrain(),
      storeContent
    )
  }

  /** Reclaim orphaned rows in batches; their missing session rows also make crash recovery resumable. */
  private scheduleOrphanDrain(): void {
    this.drainRequested = true
    if (this.draining || this.closed) {
      return
    }
    this.draining = true
    // Defer the first synchronous drain batch until after the committing call returns.
    void Promise.resolve().then(() => this.runOrphanDrain())
  }

  private async runOrphanDrain(): Promise<void> {
    try {
      while (this.drainRequested && !this.closed) {
        this.drainRequested = false
        await drainOrphanedMessages(this.db, () => this.closed)
      }
    } catch (error) {
      if (!this.closed) {
        this.onError(error)
      }
    } finally {
      this.draining = false
    }
  }

  /** Keep reads synchronous: transactions or iterators held across awaits pin the WAL. */
  get connection(): SyncDatabase {
    return this.db
  }

  setRetentionCutoffMs(cutoffMs: number | null): void {
    this.retentionCutoffMs = cutoffMs
  }

  get retentionCutoff(): number | null {
    return this.retentionCutoffMs
  }

  /** Sidebar reads also reach the consumer, so enforce retention beyond the indexer’s own decisions. */
  private withinRetention(candidate: SessionFileCandidate): boolean {
    return this.retentionCutoffMs === null || candidate.file.mtimeMs >= this.retentionCutoffMs
  }

  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    try {
      return this.writer.indexedFile(path, identity)
    } catch (error) {
      this.onError(error)
      return null
    }
  }

  /** A cold list read must not rewrite a complete, unchanged search entry. */
  coversTranscript(candidate: SessionFileCandidate): boolean {
    const file = candidate.file
    if (this.closed || typeof file.sizeBytes !== 'number') {
      return false
    }
    const identity = fileIdentity(file)
    try {
      return (
        this.db
          .prepare(
            // With a known file identity, a missing stored identity must force a rewrite.
            `SELECT 1 FROM files WHERE path = ? AND state = 'current'
           AND mtime_ms = ? AND size_bytes = ? AND byte_offset = size_bytes
           AND (? IS NULL OR (CAST(dev AS REAL) = ? AND CAST(ino AS REAL) = ?))`
          )
          .get(
            file.path,
            file.mtimeMs,
            file.sizeBytes,
            identity?.dev ?? null,
            identity?.dev ?? null,
            identity?.ino ?? null
          ) !== undefined
      )
    } catch (error) {
      this.onError(error)
      return false
    }
  }

  /** A current cursor with bytes past it, and the hash a replacement read must reproduce to append there. */
  resumableCursor(candidate: SessionFileCandidate): SessionSearchResumableCursor | null {
    const file = candidate.file
    if (this.closed || typeof file.sizeBytes !== 'number') {
      return null
    }
    const identity = fileIdentity(file)
    try {
      const row = asRecord(
        this.db
          .prepare(
            `SELECT byte_offset AS byteOffset, prefix_hash AS prefixHash FROM files
             WHERE path = ? AND state = 'current' AND prefix_hash IS NOT NULL
             AND byte_offset > 0 AND byte_offset < ?
             AND (? IS NULL OR (CAST(dev AS REAL) = ? AND CAST(ino AS REAL) = ?))`
          )
          .get(
            file.path,
            file.sizeBytes,
            identity?.dev ?? null,
            identity?.dev ?? null,
            identity?.ino ?? null
          )
      )
      return typeof row?.byteOffset === 'number' && typeof row.prefixHash === 'string'
        ? { byteOffset: row.byteOffset, prefixHash: row.prefixHash }
        : null
    } catch (error) {
      this.onError(error)
      return null
    }
  }

  beginWrite(
    candidate: SessionFileCandidate,
    mode: 'replace' | 'append',
    previousByteOffset: number,
    identity?: () => TranscriptSessionIdentity | null
  ): SessionSearchFileWrite | null {
    if (this.closed || !this.withinRetention(candidate)) {
      return null
    }
    try {
      return this.writer.beginWrite(candidate, mode, previousByteOffset, identity)
    } catch (error) {
      this.reportWriteFailure(error)
      return null
    }
  }

  /**
   * True when the rows this index holds were decoded with message bodies in them.
   *
   * A store that predates the record has never been asked to keep content, which
   * is the answer that makes the first enablement re-read rather than assume.
   */
  contentRowsIndexed(): boolean {
    const row: unknown = this.db
      .prepare("SELECT value FROM meta WHERE key = 'content_indexed'")
      .get()
    return typeof row === 'object' && row !== null && 'value' in row && row.value === '1'
  }

  /**
   * The whole read every indexed row owes the newly consented content tier.
   *
   * Consent turned on cannot be answered by the stat comparison those rows
   * already passed: their files have not changed and their message rows were
   * never written, so nothing but a whole read can add them, and until one runs
   * a full-text search over that history answers with nothing at all. The
   * marking and the record share one transaction, so a process that dies between
   * them cannot leave rows that look current under a tier nothing decoded them
   * under — the failure mode no later pass would notice.
   */
  adoptContentTier(): void {
    try {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db
          .prepare(
            `UPDATE files SET state = 'due', fail_count = 0, failed_mtime_ms = NULL
             WHERE state != 'due'`
          )
          .run()
        this.db
          .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('content_indexed', '1')")
          .run()
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      // Reported, not thrown: the next construction finds the record missing and
      // marks the rows again, so one failed write is not a stranded index.
      this.onError(error)
    }
  }

  /**
   * A read that landed. Written after the commit rather than inside it: the
   * transaction owns the rows and the cursor, and a crash between the two
   * leaves a row that says `failed` over content that is in fact current, which
   * the next pass fixes by reading a file it did not have to.
   */
  writeCommitted(candidate: SessionFileCandidate): void {
    this.setFileState(candidate.file.path, 'current')
  }

  reportWriteFailure(error: unknown): void {
    this.onError(error)
  }

  files(): SessionSearchFileRow[] {
    return (
      this.db
        .prepare(
          // Numeric stat IDs may exceed SQLite's safe INTEGER-to-number read range.
          `SELECT path, CAST(dev AS REAL) AS dev, CAST(ino AS REAL) AS ino,
                  mtime_ms AS mtimeMs, size_bytes AS sizeBytes,
                  state, fail_count AS failCount, failed_mtime_ms AS failedMtimeMs
           FROM files`
        )
        .all() as (Omit<SessionSearchFileRow, 'identity'> & {
        dev: number | null
        ino: number | null
      })[]
    ).map((row) => ({
      path: row.path,
      identity:
        typeof row.dev === 'number' && typeof row.ino === 'number'
          ? { dev: row.dev, ino: row.ino }
          : null,
      mtimeMs: row.mtimeMs,
      sizeBytes: row.sizeBytes,
      state: row.state,
      failCount: row.failCount,
      failedMtimeMs: row.failedMtimeMs
    }))
  }

  setFileState(path: string, state: SessionSearchFileState, atMtimeMs?: number): void {
    try {
      if (state === 'failed') {
        // Persist initial failures too, or unreadable new files retry forever.
        this.db
          .prepare(
            `INSERT INTO files(path, byte_offset, mtime_ms, state, fail_count, failed_mtime_ms)
             VALUES (?, 0, ?, 'failed', 1, ?)
             ON CONFLICT(path) DO UPDATE SET
               state = 'failed',
               fail_count = files.fail_count + 1,
               failed_mtime_ms = excluded.failed_mtime_ms`
          )
          .run(path, atMtimeMs ?? 0, atMtimeMs ?? null)
        return
      }
      this.db
        .prepare(
          'UPDATE files SET state = ?, fail_count = 0, failed_mtime_ms = NULL WHERE path = ?'
        )
        .run(state, path)
    } catch (error) {
      this.onError(error)
    }
  }

  stateCounts(): SessionSearchStateCounts {
    const rows = this.db.prepare('SELECT state, count(*) AS n FROM files GROUP BY state').all() as {
      state: SessionSearchFileState
      n: number
    }[]
    const counts: SessionSearchStateCounts = {
      current: 0,
      due: 0,
      failed: 0,
      sessionsByAgent: this.sessionsByAgent(),
      messages: 0
    }
    for (const row of rows) {
      counts[row.state] = Number(row.n)
    }
    counts.messages = this.messageCount()
    return counts
  }

  // Count indexed sessions without scanning their messages on every status poll.
  private sessionsByAgent(): Record<string, number> {
    const rows = this.db.prepare('SELECT agent, count(*) AS n FROM sessions GROUP BY agent').all()
    const counts: Record<string, number> = {}
    for (const row of rows) {
      const agent = asRecord(row)?.agent
      const total = asRecord(row)?.n
      if (typeof agent === 'string' && typeof total === 'number') {
        counts[agent] = total
      }
    }
    return counts
  }

  private messageCount(): number {
    const row: unknown = this.db.prepare('SELECT count(*) AS n FROM messages').get()
    if (row && typeof row === 'object' && 'n' in row && typeof row.n === 'number') {
      return row.n
    }
    return 0
  }

  /** Only proven deletion permits removal; unreadable sources retain their indexed rows. */
  removeFile(path: string): void {
    try {
      this.writer.removeFile(path)
    } catch (error) {
      this.onError(error)
    }
  }

  async purgeOlderThan(cutoffMs: number | null, signal?: AbortSignal): Promise<void> {
    try {
      await deleteExpiredSearchFiles(
        this.db,
        cutoffMs,
        () => this.closed || signal?.aborted === true
      )
    } catch (error) {
      if (!this.closed) {
        this.onError(error)
      }
    }
  }

  close(): void {
    // Repeated close calls throw ERR_INVALID_STATE in node:sqlite.
    if (this.closed) {
      return
    }
    this.closed = true
    this.writer.close()
    this.db.close()
  }
}
