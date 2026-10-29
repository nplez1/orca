import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SyncDatabase from './sync-database'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'

export type VersionedCacheDatabaseSchema = {
  version: number
  // Idempotent DDL, including `meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // which holds the schema version.
  sql: string
  // Runs inside the same rebuild-on-corruption scope as the schema.
  afterSchema?: (db: SyncDatabase) => void
  // SQLite will not create the directory; this is its mode when this call does.
  directoryMode?: number
  // Applies only to a new file; rows near half a default page waste the other half.
  pageSize?: number
}

/** A cache written by a build newer than this one: refuse it instead of destroying the newer build's index. */
export class CacheDatabaseNewerThanBuildError extends Error {
  constructor(
    readonly path: string,
    readonly storedVersion: string,
    readonly buildVersion: string
  ) {
    super(
      `Cache ${path} has schema ${storedVersion}, newer than this build's ${buildVersion}; leaving it untouched`
    )
    this.name = 'CacheDatabaseNewerThanBuildError'
  }
}

/** Rebuild unreadable/stale cache schemas: source files remain authoritative, so replacement costs only a rescan instead of stranding the feature. */
export function openVersionedCacheDatabase(
  path: string,
  schema: VersionedCacheDatabaseSchema
): SyncDatabase {
  // Create the directory first; SQLite CANTOPEN is correctly not classified as corruption.
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: schema.directoryMode })
  }
  try {
    return openExisting(path, schema)
  } catch (error) {
    if (!isUnusableDatabaseError(error)) {
      throw error
    }
    // One retry only: a second failure on a file we just created is not corruption.
    removeVersionedCacheDatabase(path)
    return openExisting(path, schema)
  }
}

function openExisting(path: string, schema: VersionedCacheDatabaseSchema): SyncDatabase {
  // Null closed handles so cleanup cannot mask the real failure with ERR_INVALID_STATE.
  let db: SyncDatabase | null = openWithPragmas(path, schema.pageSize)
  try {
    const storedVersion = storedSchemaVersion(db)
    // Why refuse rather than unlink: a downgrade would otherwise delete an index a newer build built,
    // and the next upgrade would rebuild it again — a full rescan per downgrade-and-return. An older
    // or unparseable version is rebuilt as before: this build's schema is what the rows are read as.
    if (storedVersion !== null && Number(storedVersion) > schema.version) {
      throw new CacheDatabaseNewerThanBuildError(path, storedVersion, String(schema.version))
    }
    if (storedVersion !== null && storedVersion !== String(schema.version)) {
      // Unlink stale caches; dropping multi-GB tables can exceed scanner readiness deadlines.
      releaseForRemoval(db)
      db = null
      removeVersionedCacheDatabase(path)
      db = openWithPragmas(path, schema.pageSize)
    }
    db.exec(schema.sql)
    schema.afterSchema?.(db)
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      'schema_version',
      String(schema.version)
    )
    return db
  } catch (error) {
    db?.close()
    throw error
  }
}

// Torn pages may fail only at first query; match both SQLite code and message.
const UNUSABLE_DATABASE =
  /SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database|database disk image is malformed/i

function isUnusableDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = 'code' in error ? error.code : undefined
  return (
    (typeof code === 'string' && UNUSABLE_DATABASE.test(code)) ||
    UNUSABLE_DATABASE.test(error.message)
  )
}

function openWithPragmas(path: string, pageSize: number | undefined): SyncDatabase {
  const db = new SyncDatabase(path)
  try {
    // Set busy timeout before WAL pragmas so another process's lock can clear.
    db.pragma('busy_timeout = 5000')
    if (pageSize !== undefined) {
      db.pragma(`page_size = ${pageSize}`)
    }
    // Enable incremental vacuum before tables exist so purges can return pages in bounded steps.
    db.pragma('auto_vacuum = INCREMENTAL')
    // WAL readers see committed state while writers publish atomically.
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('journal_size_limit = 8388608')
    return db
  } catch (error) {
    db?.close()
    throw error
  }
}

export function removeVersionedCacheDatabase(path: string): void {
  if (path === ':memory:') {
    return
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    removeTreeSync(`${path}${suffix}`)
  }
}

/** No meta table is a fresh database; missing/unparseable version rows in existing meta indicate stale data and must rebuild rather than seed over it. */
function storedSchemaVersion(db: SyncDatabase): string | null {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get()
  if (!table) {
    return null
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  const value = row?.value
  return typeof value === 'string' || typeof value === 'number' ? String(value) : 'NaN'
}

/**
 * Close the handle before the files are removed.
 *
 * Why not an exclusive lock: `BEGIN EXCLUSIVE` is released by the close that precedes the unlink, and in
 * WAL mode it does not block readers anyway. A second process that opens this file after this point
 * holds a handle to an unlinked inode until it notices, which SQLite gives no way to prevent from here.
 */
function releaseForRemoval(db: SyncDatabase): void {
  db.close()
}
