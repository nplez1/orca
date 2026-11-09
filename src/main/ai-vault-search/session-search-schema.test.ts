import type * as NodeFs from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { asRecord } from '../ai-vault/session-scanner-record-value'
import SyncDatabase from '../sqlite/sync-database'
import { CacheDatabaseNewerThanBuildError } from '../sqlite/versioned-cache-database'
import {
  SESSION_SEARCH_SCHEMA_VERSION,
  addSessionSearchPrefixHashColumn,
  openSessionSearchDatabase,
  removeSessionSearchDatabase
} from './session-search-schema'

const recordedRmSync = vi.hoisted(() => vi.fn())
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      recordedRmSync(...args)
      return actual.rmSync(...args)
    }
  }
})

let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => removeTree(root)))
  roots = []
})

async function tempDatabasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-search-schema-'))
  roots.push(root)
  return join(root, 'index.sqlite')
}

function schemaVersion(db: SyncDatabase): string | undefined {
  return (
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined
  )?.value
}

describe('openSessionSearchDatabase', () => {
  it('keeps a version 8 index that predates prefix hashes and adds the column', async () => {
    const path = await tempDatabasePath()
    const first = openSessionSearchDatabase(path)
    first.exec('ALTER TABLE files DROP COLUMN prefix_hash')
    first.prepare("INSERT INTO files(path,byte_offset,mtime_ms) VALUES ('a',1,1)").run()
    first.close()

    const second = openSessionSearchDatabase(path)
    expect(second.prepare('SELECT path, prefix_hash FROM files').all()).toEqual([
      { path: 'a', prefix_hash: null }
    ])
    second.close()
  })

  it('adds the prefix hash column once when another opener migrates under its lock', async () => {
    const path = await tempDatabasePath()
    const setup = openSessionSearchDatabase(path)
    setup.exec('ALTER TABLE files DROP COLUMN prefix_hash')
    setup.close()
    const opener = new SyncDatabase(path)
    opener.pragma('busy_timeout = 5000')
    // The other opener holds its uncommitted ALTER while this one runs the migration.
    const rival = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads')
      const db = new (require('node:sqlite').DatabaseSync)(workerData.path)
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
      db.exec('ALTER TABLE files ADD COLUMN prefix_hash TEXT')
      parentPort.postMessage('locked')
      setTimeout(() => { db.exec('COMMIT'); db.close(); parentPort.close() }, 300)
      `,
      { eval: true, workerData: { path } }
    )
    try {
      await new Promise<void>((resolve, reject) => {
        rival.once('message', () => resolve())
        rival.once('error', reject)
      })
      expect(() => addSessionSearchPrefixHashColumn(opener)).not.toThrow()
      const columns = opener
        .prepare('PRAGMA table_info(files)')
        .all()
        .filter((column) => asRecord(column)?.name === 'prefix_hash')
      expect(columns).toHaveLength(1)
    } finally {
      opener.close()
      await rival.terminate()
    }
  })

  it('carries the metadata and content FTS tables and rebuilds over a foreign one', async () => {
    const path = await tempDatabasePath()
    const fresh = openSessionSearchDatabase(path)
    const tables = (): string[] =>
      (
        fresh
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_fts'")
          .all() as { name: string }[]
      ).map((row) => row.name)
    expect(tables().sort()).toEqual(['messages_fts', 'session_metadata_fts'])

    // A version bump must remove obsolete tables that CREATE IF NOT EXISTS would retain.
    fresh.exec('CREATE VIRTUAL TABLE conversation_fts USING fts5(user_text, assistant_text)')
    fresh.prepare("INSERT INTO files(path,byte_offset,mtime_ms) VALUES ('a',1,1)").run()
    fresh.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run()
    fresh.close()

    const rebuilt = openSessionSearchDatabase(path)
    expect(schemaVersion(rebuilt)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
    expect(
      rebuilt
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'conversation_fts'")
        .get()
    ).toEqual({ n: 0 })
    expect(rebuilt.prepare('SELECT COUNT(*) AS c FROM files').get()).toEqual({ c: 0 })
    rebuilt.close()
  })

  it('replaces the file on a version mismatch instead of dropping tables in place', async () => {
    const path = await tempDatabasePath()
    const stale = openSessionSearchDatabase(path)
    stale.prepare("INSERT INTO files(path,byte_offset,mtime_ms) VALUES ('a',1,1)").run()
    stale
      .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
      .run(String(SESSION_SEARCH_SCHEMA_VERSION - 1))
    stale.exec('ALTER TABLE messages DROP COLUMN text_truncated')
    stale.close()
    // Remove stale WAL sidecars so SQLite cannot replay them into the rebuilt cache.
    await writeFile(`${path}-wal`, 'stale wal bytes')
    const before = await stat(path)

    const fresh = openSessionSearchDatabase(path)
    expect(schemaVersion(fresh)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
    expect(fresh.prepare('SELECT COUNT(*) AS c FROM files').get()).toEqual({
      c: 0
    })
    expect(fresh.prepare('SELECT text_truncated FROM messages').all()).toEqual([])
    fresh.close()
    // Inodes may be reused immediately; verify sidecar removal instead.
    await expect(stat(`${path}-wal`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(path)).mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs)
  })

  it('removes the database with every sidecar', async () => {
    const path = await tempDatabasePath()
    openSessionSearchDatabase(path).close()
    await writeFile(`${path}-shm`, '')
    removeSessionSearchDatabase(path)
    for (const suffix of ['', '-wal', '-shm']) {
      await expect(stat(`${path}${suffix}`)).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  })
})

it('rebuilds a file too corrupt to open instead of refusing forever', async () => {
  const path = await tempDatabasePath()
  const healthy = openSessionSearchDatabase(path)
  healthy.prepare("INSERT INTO files(path,byte_offset,mtime_ms) VALUES ('a',1,1)").run()
  healthy.close()
  // Corrupt data pages while retaining the header so failure occurs after opening.
  const bytes = await readFile(path)
  bytes.fill(0x7f, 4096, Math.min(bytes.length, 12_288))
  await writeFile(path, bytes)

  const rebuilt = openSessionSearchDatabase(path)
  try {
    expect(schemaVersion(rebuilt)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
    expect(rebuilt.prepare('SELECT COUNT(*) AS c FROM files').get()).toEqual({
      c: 0
    })
  } finally {
    rebuilt.close()
  }
})

it('surfaces the unlink failure itself when a stale index cannot be removed', async () => {
  const path = await tempDatabasePath()
  const stale = openSessionSearchDatabase(path)
  // Why an older version: a newer one is refused untouched (see the newer-schema case), so only an
  // older index is the one this build tries to unlink.
  stale
    .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
    .run(String(SESSION_SEARCH_SCHEMA_VERSION - 1))
  stale.close()
  recordedRmSync.mockReset()
  recordedRmSync.mockImplementation(() => {
    throw Object.assign(new Error('EPERM: operation not permitted, unlink'), {
      code: 'EPERM'
    })
  })
  try {
    // A second close could hide the unlink error behind ERR_INVALID_STATE.
    expect(() => openSessionSearchDatabase(path)).toThrow(/EPERM/)
    expect(() => openSessionSearchDatabase(path)).not.toThrow(/not open/)
  } finally {
    recordedRmSync.mockReset()
  }
})

it('refuses a newer index without unlinking it', async () => {
  const path = await tempDatabasePath()
  const newer = openSessionSearchDatabase(path)
  newer
    .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
    .run(String(SESSION_SEARCH_SCHEMA_VERSION + 1))
  newer.close()

  expect(() => openSessionSearchDatabase(path)).toThrow(CacheDatabaseNewerThanBuildError)
  const probe = new SyncDatabase(path)
  try {
    // The newer build's file, and its version stamp, are still there.
    expect(schemaVersion(probe)).toBe(String(SESSION_SEARCH_SCHEMA_VERSION + 1))
  } finally {
    probe.close()
  }
})
