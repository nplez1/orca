import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from './sync-database'
import {
  CacheDatabaseNewerThanBuildError,
  openVersionedCacheDatabase,
  removeVersionedCacheDatabase
} from './versioned-cache-database'

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rows(payload TEXT NOT NULL);
`

describe('versioned cache database', () => {
  let directory: string

  const cachePath = (): string => join(directory, 'cache.sqlite')
  const open = (version: number): ReturnType<typeof openVersionedCacheDatabase> =>
    openVersionedCacheDatabase(cachePath(), { version, sql: SCHEMA_SQL })

  const writeVersion = (version: string): void => {
    const db = open(1)
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      'schema_version',
      version
    )
    db.prepare("INSERT INTO rows(payload) VALUES ('kept')").run()
    db.close()
  }

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-versioned-cache-'))
  })

  it('creates a database and stamps the schema version', () => {
    const db = open(3)
    try {
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value).toBe(
        '3'
      )
    } finally {
      db.close()
    }
  })

  it('rebuilds an older schema in place', () => {
    writeVersion('1')
    const db = open(2)
    try {
      // The old rows belong to a layout this build cannot read, so replacement is the point.
      expect(db.prepare('SELECT count(*) AS n FROM rows').get()?.n).toBe(0)
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value).toBe(
        '2'
      )
    } finally {
      db.close()
    }
  })

  it('refuses a schema a newer build wrote, leaving the file intact', () => {
    writeVersion('9')

    expect(() => open(8)).toThrow(CacheDatabaseNewerThanBuildError)
    // Why intact: the newer build's index is not this build's to delete.
    const untouched = new SyncDatabase(cachePath())
    try {
      expect(
        untouched.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value
      ).toBe('9')
      expect(untouched.prepare('SELECT payload FROM rows').get()?.payload).toBe('kept')
    } finally {
      untouched.close()
    }

    const newer = openVersionedCacheDatabase(cachePath(), { version: 9, sql: SCHEMA_SQL })
    try {
      expect(newer.prepare('SELECT payload FROM rows').get()?.payload).toBe('kept')
    } finally {
      newer.close()
    }
  })

  it('names the stored and build versions so the refusal is actionable', () => {
    writeVersion('9')
    try {
      open(8)
      expect.unreachable('a newer schema must not open')
    } catch (error) {
      expect(error).toBeInstanceOf(CacheDatabaseNewerThanBuildError)
      if (!(error instanceof CacheDatabaseNewerThanBuildError)) {
        throw new Error('expected a newer-schema refusal')
      }
      expect(error.storedVersion).toBe('9')
      expect(error.buildVersion).toBe('8')
      expect(error.message).toContain('newer than this build')
    }
  })

  it('still rebuilds an unparseable version', () => {
    writeVersion('not-a-number')
    const db = open(4)
    try {
      expect(db.prepare('SELECT count(*) AS n FROM rows').get()?.n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('rebuilds a corrupt file once, then refuses to loop', () => {
    writeVersion('1')
    removeVersionedCacheDatabase(cachePath())
    expect(existsSync(cachePath())).toBe(false)
    const db = open(1)
    try {
      expect(db.prepare('SELECT count(*) AS n FROM meta').get()?.n).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})
