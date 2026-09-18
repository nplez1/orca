import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import SyncDatabase from '../sqlite/sync-database'
import { cwdKey } from './session-search-file-records'
import {
  listIndexedSessions,
  type IndexedSessionList,
  type IndexedSessionListArgs
} from './session-search-list'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'

/**
 * The plan doc's latency gate: a panel load has to stay one indexed read, and
 * that read is the whole reason the list moved off the scanner.
 *
 * A wall clock cannot say that on its own — a fast machine passes a full scan and
 * sort — so the plan SQLite picks is asserted directly, and the clock is only a
 * coarse tripwire beside it.
 *
 * The corpus is written with SQL, not through the indexer: the read is under
 * test, and a corpus produced by the writer would make this a test of the
 * writer's speed. 10k rows is the plan doc's synthetic size, spread across eight
 * sibling projects so a scope has seven ranges it must not read.
 */
const SESSIONS = 10_000
const SCOPES = 8
const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z')
const MINUTE_MS = 60_000
/** Every Nth title carries a term rare enough that no limit can stop at the newest rows. */
const RARE_EVERY = 500
const RARE_TERM = 'needlefish'
const SCOPE = '/work/app-3'

/**
 * A second connection over the same file, keeping the SQL the module prepares.
 *
 * Why: the plan must be asserted against the statement `listIndexedSessions`
 * actually sends. Re-spelling its WHERE and ORDER BY here would let a change to
 * either pass this file while regressing the list.
 */
class PlannedListDatabase extends SyncDatabase {
  readonly prepared: string[] = []
  override prepare(sql: string) {
    this.prepared.push(sql)
    return super.prepare(sql)
  }
  /** The list statement from the most recent `listIndexedSessions` call. */
  lastSessionSelect(): string {
    const select = this.prepared.findLast((sql) => sql.includes(' FROM sessions '))
    if (!select) {
      throw new Error(`no sessions SELECT was prepared; saw ${this.prepared.length} statements`)
    }
    return select
  }
}

let file: SessionSearchIndexFile | null = null
let planned: PlannedListDatabase | null = null

function plannedDb(): PlannedListDatabase {
  if (!planned) {
    throw new Error('beforeAll did not open the index')
  }
  return planned
}

function seedCorpus(db: SyncDatabase, count: number): void {
  const insertSession = db.prepare(
    `INSERT INTO sessions(id,agent,session_id,file_path,codex_home,title,cwd,cwd_key,branch,model,
       created_at,updated_at,modified_at,message_count,total_tokens,queued_message_count,
       subagent_transcript_count,resume_command)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  const insertFile = db.prepare(
    `INSERT INTO files(path,byte_offset,mtime_ms,session_row_id) VALUES (?,?,?,?)`
  )
  // One transaction and prepared statements, because the seeding is not what this
  // file measures: a statement per row under autocommit is an order of magnitude
  // slower for the same corpus.
  db.exec('BEGIN')
  try {
    for (let id = 1; id <= count; id++) {
      const scope = `/work/app-${id % SCOPES}`
      const cwd = id % 4 === 0 ? `${scope}/src` : scope
      const at = BASE_MS + id * MINUTE_MS
      const updatedAt = new Date(at).toISOString()
      const title = id % RARE_EVERY === 0 ? `${RARE_TERM} ${id}` : `session ${id}`
      insertSession.run(
        id,
        id % 2 === 0 ? 'claude' : 'codex',
        String(id),
        `/synthetic/${id}.jsonl`,
        null,
        title,
        cwd,
        cwdKey(cwd),
        'main',
        'claude-fable-5',
        updatedAt,
        updatedAt,
        updatedAt,
        id % 20,
        id * 100,
        0,
        0,
        ''
      )
      // Every session has a file row, so the retention subquery has something to
      // match and cannot quietly exclude the corpus this file measures.
      insertFile.run(`/synthetic/${id}.jsonl`, 0, at, id)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

beforeAll(async () => {
  file = await openSessionSearchIndexFile('ss-list-latency')
  seedCorpus(file.db, SESSIONS)
  planned = new PlannedListDatabase(file.path)
})

afterAll(async () => {
  planned?.close()
  planned = null
  await file?.close()
  file = null
})

type ListArgs = Partial<
  Pick<IndexedSessionListArgs, 'limit' | 'scopePaths' | 'retentionCutoffMs'> & { query?: string }
>

/** The panel's own shape: a retention window is always passed. */
function list(args: ListArgs = {}, db: SyncDatabase = plannedDb()): IndexedSessionList {
  return listIndexedSessions(db, {
    limit: Number.POSITIVE_INFINITY,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    retentionCutoffMs: BASE_MS,
    ...args
  })
}

function sessionIds(result: IndexedSessionList): string[] {
  return result.sessions.map((session) => session.sessionId)
}

/**
 * The plan SQLite picks for `sql`.
 *
 * Values never steer SQLite's planner, so the parameters are bound as NULL: the
 * statement text is what is under test, not the rows it returns.
 */
function queryPlan(sql: string): string[] {
  const placeholders = Array.from({ length: sql.split('?').length - 1 }, () => null)
  return plannedDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...placeholders)
    .map((row) => String(row.detail))
}

/** `sessions` must be reached through `index`, and by a seek rather than a walk. */
function expectSessionsIndex(plan: string[], index: string, queryLabel: string): void {
  const where = `plan was:\n  ${plan.join('\n  ')}`
  const lines = plan.filter((line) => line.includes('sessions'))
  expect(
    lines.some((line) => line.includes(`INDEX ${index}`)),
    `expected ${queryLabel} to use ${index}; ${where}`
  ).toBe(true)
  expect(
    lines
      .filter((line) => line.includes(`INDEX ${index}`))
      .every((line) => line.startsWith('SEARCH')),
    `expected ${queryLabel} to seek ${index} rather than walk it; ${where}`
  ).toBe(true)
}

function expectNoSort(plan: string[], queryLabel: string): void {
  expect(
    plan.some((line) => line.includes('TEMP B-TREE')),
    `expected ${queryLabel} to stop at the limit without sorting; plan was:\n  ${plan.join('\n  ')}`
  ).toBe(false)
}

function measuredMs(run: () => unknown): number {
  // Warm first: the first read over a fresh connection pays for the page cache,
  // and these numbers are about the read, not SQLite's first touch of the file.
  run()
  const startedAt = performance.now()
  run()
  return performance.now() - startedAt
}

describe('the query plan', () => {
  // Both assertions drop the retention window the panel passes, because that
  // window rewrites the plan wholesale: its `id IN (SELECT … FROM files …)`
  // becomes the driver and `sessions` is reached by rowid seek instead. What
  // these two guard is the index the shape itself chooses — the scope's
  // `sessions_cwd_key` range and the unscoped `updated_at` order. The
  // retention-bearing plan, which is the one production uses, is characterized
  // in its own test below.
  it('lists newest-first from sessions_updated_at, without scanning sessions', () => {
    list({ limit: 100, retentionCutoffMs: null })
    const plan = queryPlan(plannedDb().lastSessionSelect())

    expectSessionsIndex(plan, 'sessions_updated_at', 'the unscoped newest-first list')
    expectNoSort(plan, 'the unscoped newest-first list')
  })

  it('seeks sessions_cwd_key for a scope', () => {
    list({ limit: 100, scopePaths: [SCOPE], retentionCutoffMs: null })
    const plan = queryPlan(plannedDb().lastSessionSelect())

    // The `cwd_key` arms are an OR over two ranges, so the rows come out of two
    // index walks and a sort is how they get ordered: not asserted away here.
    expectSessionsIndex(plan, 'sessions_cwd_key', `the scoped list for ${SCOPE}`)
  })

  it('finds the retention-bearing plan driven by files_mtime, not by sessions', () => {
    // A finding, recorded rather than wished away. The panel always passes a
    // cutoff, and that cutoff re-plans the list: SQLite walks `files_mtime`,
    // seeks `sessions` by rowid, and sorts — so the LIMIT cannot stop early,
    // because the sort sits between it and the rows. It is still index-driven
    // (not the full scan plus sort this file exists to catch), and the measured
    // 10k-row cost is in the test below. If `sessions_updated_at` ever appears
    // in this plan the finding is fixed: delete this test and fold the retention
    // window into the two assertions above.
    list({ limit: 100, scopePaths: [SCOPE] })
    const plan = queryPlan(plannedDb().lastSessionSelect())

    expect(
      plan.some((line) => line.includes('INDEX files_mtime')),
      `expected the retention window to drive the plan from files_mtime; plan was:\n  ${plan.join('\n  ')}`
    ).toBe(true)
    expect(
      plan.some((line) => line.includes('INTEGER PRIMARY KEY')),
      `expected the retention window to reach sessions by rowid; plan was:\n  ${plan.join('\n  ')}`
    ).toBe(true)
    expect(
      plan.some((line) => line.startsWith('SCAN sessions')),
      `expected no full scan of sessions; plan was:\n  ${plan.join('\n  ')}`
    ).toBe(false)
  })
})

describe('the 10k-row cost', () => {
  it('lists an unlimited scope well under a second', () => {
    const elapsedMs = measuredMs(() => list({ scopePaths: ['/work'] }))

    // Coarse tripwire, not a benchmark: an order of magnitude above the measured
    // cost, so it fires on a full scan plus sort and not on a slow host.
    expect(
      elapsedMs,
      `an unlimited scoped list over ${SESSIONS} rows took ${elapsedMs.toFixed(1)}ms`
    ).toBeLessThan(750)
  })

  it('keeps a filtered page in the same order of cost', () => {
    // A term only every 500th title carries, so no limit can stop at the newest
    // rows: this is the debounced-search worst case, not the best one.
    const elapsedMs = measuredMs(() =>
      list({ scopePaths: ['/work'], query: RARE_TERM, limit: 100 })
    )

    expect(
      elapsedMs,
      `a filtered scoped page over ${SESSIONS} rows took ${elapsedMs.toFixed(1)}ms`
    ).toBeLessThan(750)
  })
})

describe('correctness at 10k rows', () => {
  it('returns the newest row first', () => {
    expect(sessionIds(list({ limit: 10 })).slice(0, 3)).toEqual(['10000', '9999', '9998'])
  })

  it('reports truncation when the limit cuts the corpus', () => {
    const capped = list({ limit: 100 })
    expect(capped.sessions).toHaveLength(100)
    expect(capped.truncated).toBe(true)

    const all = list({ scopePaths: ['/work'] })
    expect(all.sessions).toHaveLength(SESSIONS)
    expect(all.truncated).toBe(false)
  })

  it('narrows by query, still newest first', () => {
    const found = list({ query: RARE_TERM, limit: 100 })
    expect(found.sessions).toHaveLength(SESSIONS / RARE_EVERY)
    expect(found.truncated).toBe(false)
    expect(sessionIds(found)[0]).toBe(String(SESSIONS))
    expect(list({ query: 'no-such-term-anywhere' }).sessions).toEqual([])
  })
})
