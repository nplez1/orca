import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import SyncDatabase from '../sqlite/sync-database'
import { listIndexedSessions } from './session-search-list'
import { SESSION_LIST_SCHEMA_VERSION } from './session-search-list-schema'
import { deleteExpiredSearchFiles } from './session-search-retention-delete'
import { SESSION_SEARCH_SCHEMA_VERSION, openSessionSearchDatabase } from './session-search-schema'

let roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.map((root) => removeTree(root)))
  roots = []
})

async function tempDatabasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-list-schema-'))
  roots.push(root)
  return join(root, 'index.sqlite')
}

function meta(db: SyncDatabase, key: string): string | undefined {
  const row: unknown = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row && typeof row === 'object' && 'value' in row ? String(row.value) : undefined
}

function count(db: SyncDatabase, sql: string, ...values: (string | number)[]): number {
  const row: unknown = db.prepare(`SELECT count(*) AS n FROM ${sql}`).get(...values)
  return row && typeof row === 'object' && 'n' in row ? Number(row.n) : Number.NaN
}

/** Everything a schema declares, by type and name, so two files can be compared as shapes. */
function schemaInventory(db: SyncDatabase): { objects: string[]; sessionColumns: string[] } {
  const objects = db
    .prepare(
      "SELECT type || ':' || name AS object FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY 1"
    )
    .all()
    .map((row) => String(row.object))
  const sessionColumns = (db.prepare('SELECT name FROM pragma_table_info(?)').all('sessions') ?? [])
    .map((row) => String(row.name))
    .sort()
  return { objects, sessionColumns }
}

/**
 * The layout this fork shipped at the merged schema 10: the eight list columns
 * at the end of `sessions`, and the metadata FTS table under `sessions_fts`.
 */
function rewriteAsMergedTen(path: string): void {
  const db = new SyncDatabase(path)
  try {
    db.exec(`
      DROP TRIGGER session_metadata_fts_insert;
      DROP TRIGGER session_metadata_fts_refresh;
      DROP TRIGGER session_list_reclaim;
      DROP TABLE session_list_facts;
      DROP TABLE session_metadata_fts;
      DELETE FROM meta WHERE key = 'session_list_schema_version';
      UPDATE meta SET value = '10' WHERE key = 'schema_version';
      ALTER TABLE sessions ADD COLUMN model TEXT;
      ALTER TABLE sessions ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN queued_message_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN subagent_transcript_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN modified_at TEXT;
      ALTER TABLE sessions ADD COLUMN subagent_parent_session_id TEXT;
      ALTER TABLE sessions ADD COLUMN subagent_agent_type TEXT;
      ALTER TABLE sessions ADD COLUMN subagent_parent_agent TEXT;
      CREATE VIRTUAL TABLE sessions_fts USING fts5(
        title, cwd, branch, agent, tokenize="unicode61 tokenchars '_.-/+'", detail=full
      );
    `)
    const insert = db.prepare(
      `INSERT INTO sessions(id, agent, session_id, file_path, title, cwd, cwd_key, branch,
         updated_at, message_count, resume_command, model, total_tokens, queued_message_count,
         subagent_transcript_count, modified_at, subagent_parent_session_id, subagent_agent_type,
         subagent_parent_agent)
       VALUES (?, 'claude', ?, ?, ?, '/repo/app', '/repo/app', 'main', ?, 2, '', ?, ?, 1, 0, ?, ?, ?, ?)`
    )
    insert.run(
      1,
      'root',
      '/t/root.jsonl',
      'harbor pilot',
      '2026-09-02T00:00:00.000Z',
      'claude-fable-5',
      900,
      '2026-09-02T00:00:00.000Z',
      null,
      null,
      null
    )
    insert.run(
      2,
      'child',
      '/t/child.jsonl',
      'child run',
      '2026-09-01T00:00:00.000Z',
      null,
      40,
      null,
      'root',
      'Explore',
      'pi'
    )
    db.exec(`
      INSERT INTO sessions_fts(rowid, title, cwd, branch, agent) SELECT id, title, cwd, branch, agent FROM sessions;
      INSERT INTO files(path, byte_offset, mtime_ms, session_row_id) VALUES ('/t/root.jsonl', 10, 1, 1);
      INSERT INTO files(path, byte_offset, mtime_ms, session_row_id) VALUES ('/t/child.jsonl', 10, 1, 2);
      INSERT INTO messages(id, session_row_id, role) VALUES (1, 1, 'user');
      INSERT INTO messages_fts(rowid, user_text) VALUES (1, 'lighthouse');
    `)
  } finally {
    db.close()
  }
}

it('gives a fresh index the list tier beside upstream’s tables, under its own version', async () => {
  const db = openSessionSearchDatabase(await tempDatabasePath())
  try {
    expect(meta(db, 'schema_version')).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
    expect(meta(db, 'session_list_schema_version')).toBe(String(SESSION_LIST_SCHEMA_VERSION))
    const { objects, sessionColumns } = schemaInventory(db)
    expect(objects).toEqual(
      expect.arrayContaining([
        'table:session_list_facts',
        'table:session_metadata_fts',
        'trigger:session_metadata_fts_insert',
        'trigger:session_metadata_fts_refresh',
        'trigger:session_list_reclaim'
      ])
    )
    expect(sessionColumns).not.toContain('subagent_parent_agent')
    expect(sessionColumns).not.toContain('model')
  } finally {
    db.close()
  }
})

it('migrates a merged-10 index in place: same shape as a fresh one, every row kept', async () => {
  const freshDb = openSessionSearchDatabase(await tempDatabasePath())
  const fresh = schemaInventory(freshDb)
  freshDb.close()

  const path = await tempDatabasePath()
  openSessionSearchDatabase(path).close()
  rewriteAsMergedTen(path)

  const db = openSessionSearchDatabase(path)
  try {
    // The merged 10 carried upstream 8's content. When upstream's own constant
    // moves past 8 this migration has nothing left to save; delete it then.
    expect(meta(db, 'schema_version')).toBe('8')
    expect(meta(db, 'schema_version')).toBe(String(SESSION_SEARCH_SCHEMA_VERSION))
    expect(meta(db, 'session_list_schema_version')).toBe(String(SESSION_LIST_SCHEMA_VERSION))
    expect(schemaInventory(db)).toEqual(fresh)

    expect(count(db, 'files')).toBe(2)
    expect(count(db, 'messages_fts WHERE messages_fts MATCH ?', 'lighthouse')).toBe(1)
    expect(count(db, 'session_metadata_fts WHERE session_metadata_fts MATCH ?', 'harbor')).toBe(1)

    const listed = listIndexedSessions(db, {
      limit: Number.POSITIVE_INFINITY,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    }).sessions
    expect(listed.map((session) => session.sessionId)).toEqual(['root', 'child'])
    expect(listed[0]).toMatchObject({ model: 'claude-fable-5', totalTokens: 900 })
    expect(listed[1]?.subagent).toEqual({
      parentSessionId: 'root',
      agentType: 'Explore',
      status: null,
      parentAgent: 'pi'
    })

    // AUTOINCREMENT's sequence survives the column drops, and the triggers run.
    db.prepare('UPDATE sessions SET title = ? WHERE id = 1').run('renamed lantern')
    expect(count(db, 'session_metadata_fts WHERE session_metadata_fts MATCH ?', 'lantern')).toBe(1)
    const next = db
      .prepare(
        "INSERT INTO sessions(agent, session_id, file_path, title, resume_command) VALUES ('claude', 'n', 'n', '', '')"
      )
      .run().lastInsertRowid
    expect(Number(next)).toBe(3)
  } finally {
    db.close()
  }
  // A second open is a plain open, not a second migration.
  const reopened = openSessionSearchDatabase(path)
  try {
    expect(count(reopened, 'files')).toBe(2)
  } finally {
    reopened.close()
  }
})

it.each([
  [
    'a list tier from another build',
    "UPDATE meta SET value = '0' WHERE key = 'session_list_schema_version'"
  ],
  [
    'no list tier at upstream’s version',
    "DELETE FROM meta WHERE key = 'session_list_schema_version'"
  ]
])('discards an index carrying %s', async (_label, damage) => {
  const path = await tempDatabasePath()
  const stale = openSessionSearchDatabase(path)
  stale.prepare("INSERT INTO files(path, byte_offset, mtime_ms) VALUES ('a', 1, 1)").run()
  stale.exec(damage)
  stale.close()

  const rebuilt = openSessionSearchDatabase(path)
  try {
    expect(count(rebuilt, 'files')).toBe(0)
    expect(meta(rebuilt, 'session_list_schema_version')).toBe(String(SESSION_LIST_SCHEMA_VERSION))
  } finally {
    rebuilt.close()
  }
})

it('reclaims a session’s list rows when upstream’s retention purge deletes it', async () => {
  const db = openSessionSearchDatabase(await tempDatabasePath())
  try {
    for (const [id, mtime] of [
      [1, 1],
      [2, 10_000]
    ]) {
      db.prepare(
        `INSERT INTO sessions(id, agent, session_id, file_path, title, resume_command)
         VALUES (?, 'claude', ?, ?, '', '')`
      ).run(id, String(id), String(id))
      db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('retention', id)
      db.prepare('INSERT INTO session_list_facts(session_row_id, total_tokens) VALUES (?, 1)').run(
        id
      )
      db.prepare(
        'INSERT INTO files(path, byte_offset, mtime_ms, session_row_id) VALUES (?, 1, ?, ?)'
      ).run(String(id), mtime, id)
    }
    expect(count(db, 'session_metadata_fts')).toBe(2)

    await deleteExpiredSearchFiles(db, 5_000, () => false)

    expect(count(db, 'sessions')).toBe(1)
    expect(count(db, 'session_metadata_fts')).toBe(1)
    expect(count(db, 'session_list_facts')).toBe(1)
  } finally {
    db.close()
  }
})

it('discards, rather than migrates, a merged-10 index missing any of the eight columns', async () => {
  const path = await tempDatabasePath()
  openSessionSearchDatabase(path).close()
  rewriteAsMergedTen(path)
  const legacy = new SyncDatabase(path)
  legacy.exec('ALTER TABLE sessions DROP COLUMN queued_message_count')
  legacy.close()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  const rebuilt = openSessionSearchDatabase(path)
  try {
    expect(count(rebuilt, 'files')).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  } finally {
    rebuilt.close()
  }
})

it.each([
  ['from another build', "UPDATE meta SET value = '0' WHERE key = 'session_list_schema_version'"],
  ['missing beside indexed sessions', "DELETE FROM meta WHERE key = 'session_list_schema_version'"]
])(
  'rebuilds rather than stamps a list tier %s when the pre-open check never judged it',
  async (_label, damage) => {
    const path = await tempDatabasePath()
    const stale = openSessionSearchDatabase(path)
    stale
      .prepare(
        "INSERT INTO sessions(agent, session_id, file_path, title, resume_command) VALUES ('claude', 's', 's', 't', '')"
      )
      .run()
    stale.exec(damage)
    stale.close()

    // The check's first statement throws, as a lock timeout would; the opener then keeps the file.
    vi.spyOn(SyncDatabase.prototype, 'pragma').mockImplementationOnce(() => {
      throw new Error('database is locked')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reopened = openSessionSearchDatabase(path)
    expect(warn).toHaveBeenCalledWith(
      '[ai-vault-search] list schema check skipped:',
      'database is locked'
    )
    try {
      expect(count(reopened, 'sessions')).toBe(0)
      expect(meta(reopened, 'session_list_schema_version')).toBe(
        String(SESSION_LIST_SCHEMA_VERSION)
      )
    } finally {
      reopened.close()
    }
  }
)

it('makes a session findable by metadata when its row is inserted already named', async () => {
  const db = openSessionSearchDatabase(await tempDatabasePath())
  try {
    db.prepare(
      `INSERT INTO sessions(agent, session_id, file_path, title, cwd, resume_command)
       VALUES ('claude', 's', 's', 'harbor pilot', '/repo/app', '')`
    ).run()
    expect(count(db, 'session_metadata_fts WHERE session_metadata_fts MATCH ?', 'harbor')).toBe(1)
  } finally {
    db.close()
  }
})
