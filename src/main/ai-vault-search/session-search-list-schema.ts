import { existsSync } from 'node:fs'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import SyncDatabase from '../sqlite/sync-database'
import {
  CacheDatabaseNewerThanBuildError,
  removeVersionedCacheDatabase
} from '../sqlite/versioned-cache-database'

/**
 * The fork's list and metadata-search tier, beside upstream's `sessions` table
 * rather than inside it.
 *
 * Why its own table and version key: when these columns lived in `sessions`,
 * the fork's bumps of `SESSION_SEARCH_SCHEMA_VERSION` (6→9) and upstream's
 * (6→8) collided, and a sync had to invent a merged 10 that neither side
 * understood. Upstream's constant is now upstream's alone; bump this one for a
 * change to anything in this file. A bump discards the whole index, because
 * these rows are written by the same transcript read as the `sessions` row and
 * nothing else could refill them.
 */
export const SESSION_LIST_SCHEMA_VERSION = 1
const SESSION_LIST_SCHEMA_KEY = 'session_list_schema_version'

// The version this fork wrote while its columns were still in `sessions`, and
// the upstream version whose content that layout carried.
const MERGED_LEGACY_SCHEMA_VERSION = '10'
const MERGED_LEGACY_UPSTREAM_VERSION = '8'

// messages_fts's tokenizer, so a path or identifier tokenizes alike in both tiers.
const TOKENIZER = `tokenize="unicode61 tokenchars '_.-/+'"`

const FACT_COLUMNS = [
  'model',
  'total_tokens',
  'queued_message_count',
  'subagent_transcript_count',
  'modified_at',
  'subagent_parent_session_id',
  'subagent_agent_type',
  'subagent_parent_agent'
] as const

const METADATA_FTS_REFRESH = `DELETE FROM session_metadata_fts WHERE rowid = NEW.id;
  INSERT INTO session_metadata_fts(rowid, title, cwd, branch, agent)
    VALUES (NEW.id, NEW.title, NEW.cwd, NEW.branch, NEW.agent);`

/**
 * Triggers keep both tables in step with `sessions` whichever upstream path
 * writes or deletes it, so upstream's writer, retention purge and replacement
 * delete need no fork hunks — including one that inserts a named row in one statement.
 */
const SESSION_LIST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_list_facts(
  session_row_id INTEGER PRIMARY KEY,
  -- What Agent Session History renders a row from beyond upstream's columns, so
  -- the panel is one indexed read instead of a walk and a parse.
  model TEXT,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  queued_message_count INTEGER NOT NULL DEFAULT 0,
  subagent_transcript_count INTEGER NOT NULL DEFAULT 0,
  modified_at TEXT,
  -- Sub-agent lineage; a list served from the index nests a child under its parent.
  subagent_parent_session_id TEXT,
  subagent_agent_type TEXT,
  -- The agent that owns the parent session, when the link crosses agents.
  subagent_parent_agent TEXT
);
-- The metadata tier's search surface, indexed whether or not transcript content
-- is consented to. rowid is the sessions row id.
CREATE VIRTUAL TABLE IF NOT EXISTS session_metadata_fts USING fts5(
  title, cwd, branch, agent, ${TOKENIZER}, detail=full
);
CREATE TRIGGER IF NOT EXISTS session_metadata_fts_insert AFTER INSERT ON sessions BEGIN
  ${METADATA_FTS_REFRESH}
END;
CREATE TRIGGER IF NOT EXISTS session_metadata_fts_refresh
AFTER UPDATE OF title, cwd, branch, agent ON sessions BEGIN
  ${METADATA_FTS_REFRESH}
END;
-- sessions.id is AUTOINCREMENT and never reused, so a row left behind here could never be reclaimed.
CREATE TRIGGER IF NOT EXISTS session_list_reclaim AFTER DELETE ON sessions BEGIN
  DELETE FROM session_list_facts WHERE session_row_id = OLD.id;
  DELETE FROM session_metadata_fts WHERE rowid = OLD.id;
END;
`

/** `sessions` joined to its list facts; a row with no facts yet reads as the column defaults. */
export const SESSION_LIST_FROM = `sessions LEFT JOIN session_list_facts
  ON session_list_facts.session_row_id = sessions.id`

// Coded as corruption because that is what makes the versioned opener rebuild the file.
class SessionListTierMismatchError extends Error {
  readonly code = 'SQLITE_CORRUPT'
  constructor(listVersion: string | undefined) {
    super(`session list tier ${listVersion ?? 'missing'} does not match the indexed sessions`)
    this.name = 'SessionListTierMismatchError'
  }
}

/** Run inside the versioned opener's schema step, so a fresh index gets the tier too. */
export function ensureSessionListSchema(db: SyncDatabase): void {
  const listVersion = readMeta(db, SESSION_LIST_SCHEMA_KEY)
  if (listVersion === String(SESSION_LIST_SCHEMA_VERSION)) {
    db.exec(SESSION_LIST_SCHEMA_SQL)
    return
  }
  // Backstop for a failed pre-open check: an unchanged file's session is never re-read to fill its facts.
  if (listVersion !== undefined || hasSessionRows(db)) {
    throw new SessionListTierMismatchError(listVersion)
  }
  db.exec(SESSION_LIST_SCHEMA_SQL)
  // Why OR IGNORE: two processes opening a fresh index can both see the key absent, and `key` is a
  // primary key -- a plain INSERT would throw a constraint error the opener does not treat as
  // unusable, so that open would fail. Never overwrite is the intent; not throwing is the fix.
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run(
    SESSION_LIST_SCHEMA_KEY,
    String(SESSION_LIST_SCHEMA_VERSION)
  )
}

export function writeSessionListFacts(
  db: SyncDatabase,
  rowId: number,
  session: AiVaultSession
): void {
  db.prepare(
    `INSERT OR REPLACE INTO session_list_facts(session_row_id, ${FACT_COLUMNS.join(', ')})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rowId,
    session.model,
    session.totalTokens,
    session.queuedMessageCount,
    session.subagentTranscriptCount,
    session.modifiedAt,
    session.subagent?.parentSessionId ?? null,
    session.subagent?.agentType ?? null,
    session.subagent?.parentAgent ?? null
  )
}

/**
 * Runs before the versioned opener, which would otherwise unlink a merged-10
 * index on sight: it migrates that layout in place, and discards an index whose
 * list tier is missing or from another build. A file this cannot read is left
 * for the opener, which already rebuilds unreadable files.
 */
export function prepareSessionListSchema(path: string): void {
  if (path === ':memory:' || !existsSync(path)) {
    return
  }
  let disposition: 'keep' | 'discard' = 'keep'
  let newerVersion: string | null = null
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(path)
    db.pragma('busy_timeout = 5000')
    const judged = migrateOrJudge(db)
    disposition = judged.disposition
    newerVersion = judged.newerVersion
  } catch (error) {
    console.warn(
      '[ai-vault-search] list schema check skipped:',
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    db?.close()
  }
  if (disposition === 'discard') {
    removeVersionedCacheDatabase(path)
  }
  // Why refuse rather than discard: a newer build wrote these columns, and rebuilding would delete the
  // index it is still using on every downgrade — a full rescan each time, for nothing.
  if (newerVersion !== null) {
    throw new CacheDatabaseNewerThanBuildError(
      path,
      newerVersion,
      String(SESSION_LIST_SCHEMA_VERSION)
    )
  }
}

function migrateOrJudge(db: SyncDatabase): {
  disposition: 'keep' | 'discard'
  newerVersion: string | null
} {
  const verdict = (disposition: 'keep' | 'discard', newerVersion: string | null = null) => ({
    disposition,
    newerVersion
  })
  if (!hasTable(db, 'meta')) {
    return verdict('keep')
  }
  const listVersion = readMeta(db, SESSION_LIST_SCHEMA_KEY)
  if (listVersion === String(SESSION_LIST_SCHEMA_VERSION)) {
    return verdict('keep')
  }
  const numericListVersion = Number(listVersion)
  if (listVersion !== undefined && numericListVersion > SESSION_LIST_SCHEMA_VERSION) {
    return verdict('keep', listVersion)
  }
  if (listVersion !== undefined || !isMergedLegacyLayout(db)) {
    return verdict('discard')
  }
  // IMMEDIATE so a second process opening the same file waits, then re-checks.
  db.exec('BEGIN IMMEDIATE')
  try {
    if (readMeta(db, SESSION_LIST_SCHEMA_KEY) === undefined && isMergedLegacyLayout(db)) {
      migrateMergedLegacyLayout(db)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return verdict('keep')
}

function isMergedLegacyLayout(db: SyncDatabase): boolean {
  const columns = sessionColumns(db)
  return (
    readMeta(db, 'schema_version') === MERGED_LEGACY_SCHEMA_VERSION &&
    hasTable(db, 'sessions_fts') &&
    FACT_COLUMNS.every((column) => columns.has(column))
  )
}

/**
 * Moves the fork's columns and FTS rows out of upstream's tables, keeping every
 * row: the index can hold sessions whose transcripts are already gone.
 */
function migrateMergedLegacyLayout(db: SyncDatabase): void {
  // Renamed first, or the IF NOT EXISTS below would create an empty one in its place.
  db.exec('ALTER TABLE sessions_fts RENAME TO session_metadata_fts')
  db.exec(SESSION_LIST_SCHEMA_SQL)
  db.exec(
    `INSERT OR REPLACE INTO session_list_facts(session_row_id, ${FACT_COLUMNS.join(', ')})
     SELECT id, ${FACT_COLUMNS.join(', ')} FROM sessions`
  )
  for (const column of FACT_COLUMNS) {
    db.exec(`ALTER TABLE sessions DROP COLUMN ${column}`)
  }
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
    MERGED_LEGACY_UPSTREAM_VERSION
  )
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
    SESSION_LIST_SCHEMA_KEY,
    String(SESSION_LIST_SCHEMA_VERSION)
  )
}

function hasTable(db: SyncDatabase, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  )
}

function hasSessionRows(db: SyncDatabase): boolean {
  return db.prepare('SELECT 1 AS present FROM sessions LIMIT 1').get() !== undefined
}

function readMeta(db: SyncDatabase, key: string): string | undefined {
  const row: unknown = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row && typeof row === 'object' && 'value' in row && typeof row.value === 'string'
    ? row.value
    : undefined
}

function sessionColumns(db: SyncDatabase): Set<string> {
  const rows: unknown = db.pragma('table_info(sessions)')
  const names = new Set<string>()
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (row && typeof row === 'object' && 'name' in row && typeof row.name === 'string') {
        names.add(row.name)
      }
    }
  }
  return names
}
