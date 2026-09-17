import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type SyncDatabase from '../sqlite/sync-database'
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

// The list is one indexed read over rows other tests write through the real
// writer. Seeding `sessions` here directly keeps every assertion about the read
// and not about the parser that produced the row.

let index: SessionSearchIndexFile | null = null

afterEach(async () => {
  await index?.close()
  index = null
})

async function openIndex(): Promise<SyncDatabase> {
  index = await openSessionSearchIndexFile('ss-list')
  return index.db
}

type SeededSession = {
  id: number
  agent?: AiVaultAgent
  sessionId?: string
  filePath?: string
  codexHome?: string | null
  title?: string
  cwd?: string | null
  branch?: string | null
  model?: string | null
  createdAt?: string | null
  /** Explicit `null` is the half-decoded row; `undefined` takes the fixture default. */
  updatedAt?: string | null
  modifiedAt?: string | null
  messageCount?: number
  totalTokens?: number
  queuedMessageCount?: number
  subagentTranscriptCount?: number
  resumeCommand?: string
}

function seed(db: SyncDatabase, row: SeededSession): void {
  const cwd = row.cwd ?? null
  db.prepare(
    `INSERT INTO sessions(id,agent,session_id,file_path,codex_home,title,cwd,cwd_key,branch,model,
       created_at,updated_at,modified_at,message_count,total_tokens,queued_message_count,
       subagent_transcript_count,resume_command)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id,
    row.agent ?? 'claude',
    row.sessionId ?? String(row.id),
    row.filePath ?? `/synthetic/${row.id}.jsonl`,
    row.codexHome ?? null,
    row.title ?? `session ${row.id}`,
    cwd,
    cwdKey(cwd),
    row.branch ?? null,
    row.model ?? null,
    row.createdAt ?? null,
    row.updatedAt === undefined ? '2026-09-01T00:00:00.000Z' : row.updatedAt,
    row.modifiedAt ?? null,
    row.messageCount ?? 0,
    row.totalTokens ?? 0,
    row.queuedMessageCount ?? 0,
    row.subagentTranscriptCount ?? 0,
    row.resumeCommand ?? ''
  )
}

type ListArgs = Partial<
  Pick<
    IndexedSessionListArgs,
    'limit' | 'scopePaths' | 'agents' | 'since' | 'retentionCutoffMs' | 'query'
  >
>

function list(db: SyncDatabase, args: ListArgs = {}): IndexedSessionList {
  return listIndexedSessions(db, {
    limit: Number.POSITIVE_INFINITY,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    ...args
  })
}

function sessionIds(result: IndexedSessionList): string[] {
  return result.sessions.map((session) => session.sessionId)
}

describe('ordering', () => {
  it('returns newest first and breaks a tie on id, descending', async () => {
    const db = await openIndex()
    seed(db, { id: 1, updatedAt: '2026-09-01T00:00:00.000Z' })
    seed(db, { id: 2, updatedAt: '2026-09-02T00:00:00.000Z' })
    seed(db, { id: 3, updatedAt: '2026-09-01T00:00:00.000Z' })

    // The same instant on two rows is the common case: a sweep decodes several
    // transcripts in one pass. Without the id arm their order is plan-dependent.
    expect(sessionIds(list(db))).toEqual(['2', '3', '1'])
  })
})

describe('a row with no updated_at', () => {
  it('is excluded, because it is a session a chunked read has not finished', async () => {
    const db = await openIndex()
    seed(db, { id: 1, updatedAt: '2026-09-01T00:00:00.000Z' })
    seed(db, { id: 2, title: '', updatedAt: null })

    expect(sessionIds(list(db))).toEqual(['1'])
    // It is not "there but blank": nothing downstream may render it at all.
    expect(list(db).truncated).toBe(false)
  })
})

describe('the bound', () => {
  it('returns exactly the limit and reports the row it did not return', async () => {
    const db = await openIndex()
    for (const id of [1, 2, 3]) {
      seed(db, { id, updatedAt: `2026-09-0${id}T00:00:00.000Z` })
    }

    const capped = list(db, { limit: 2 })
    expect(sessionIds(capped)).toEqual(['3', '2'])
    expect(capped.truncated).toBe(true)
  })

  it('does not report truncation when the limit covers everything', async () => {
    const db = await openIndex()
    for (const id of [1, 2, 3]) {
      seed(db, { id, updatedAt: `2026-09-0${id}T00:00:00.000Z` })
    }

    // The boundary is the +1 probe: a bound of exactly the row count reached the
    // end of the result and has nothing to hide.
    const exact = list(db, { limit: 3 })
    expect(sessionIds(exact)).toEqual(['3', '2', '1'])
    expect(exact.truncated).toBe(false)
    expect(list(db, { limit: 10 }).truncated).toBe(false)
  })

  it('returns everything under an infinite limit and never reports truncation', async () => {
    const db = await openIndex()
    for (const id of [1, 2, 3, 4]) {
      seed(db, { id, updatedAt: `2026-09-0${id}T00:00:00.000Z` })
    }

    const all = list(db, { limit: Number.POSITIVE_INFINITY })
    expect(sessionIds(all)).toEqual(['4', '3', '2', '1'])
    expect(all.truncated).toBe(false)
  })
})

describe('scopePaths', () => {
  it('matches the scope itself and anything below it, never a prefixed sibling', async () => {
    const db = await openIndex()
    seed(db, { id: 1, cwd: '/work/app' })
    seed(db, { id: 2, cwd: '/work/app/src' })
    seed(db, { id: 3, cwd: '/work/app-other' })
    seed(db, { id: 4, cwd: '/work' })

    // A bare key range would swallow `/work/app-other`, which is a different
    // project; the prefix has to stop at the separator.
    expect(sessionIds(list(db, { scopePaths: ['/work/app'] }))).toEqual(['2', '1'])
    expect(sessionIds(list(db, { scopePaths: ['/work'] }))).toEqual(['4', '3', '2', '1'])
  })

  it('never matches a session whose transcript recorded no cwd', async () => {
    const db = await openIndex()
    seed(db, { id: 1, cwd: null })
    seed(db, { id: 2, cwd: '/work/app' })

    expect(sessionIds(list(db, { scopePaths: ['/work/app'] }))).toEqual(['2'])
  })
})

describe('agent and recency narrowings', () => {
  it('narrows by agent and by an updated-at floor, and the two compose', async () => {
    const db = await openIndex()
    seed(db, { id: 1, agent: 'claude', updatedAt: '2026-09-01T00:00:00.000Z' })
    seed(db, { id: 2, agent: 'codex', updatedAt: '2026-09-05T00:00:00.000Z' })

    expect(sessionIds(list(db, { agents: ['codex'] }))).toEqual(['2'])
    expect(sessionIds(list(db, { since: '2026-09-03T00:00:00.000Z' }))).toEqual(['2'])
    expect(sessionIds(list(db, { agents: ['claude'], since: '2026-09-03T00:00:00.000Z' }))).toEqual(
      []
    )
  })
})

describe('the query filter', () => {
  it('matches a substring of a title, including mid-token', async () => {
    const db = await openIndex()
    seed(db, { id: 1, title: 'a conversation about indexing' })
    seed(db, { id: 2, title: 'terminal tabs' })

    expect(sessionIds(list(db, { query: 'conversation' }))).toEqual(['1'])
    // Mid-token is the whole reason this is LIKE and not an FTS term match: the
    // tokenizer keeps `conversation` one token and a fragment would find nothing.
    expect(sessionIds(list(db, { query: 'versation' }))).toEqual(['1'])
  })

  it('matches a cwd or file path by substring across separators', async () => {
    const db = await openIndex()
    seed(db, { id: 1, cwd: '/repo/app' })
    seed(db, { id: 2, cwd: '/repo/other' })
    seed(db, { id: 3, filePath: '/transcripts/needle.jsonl' })

    // The regression this form fixed: `/repo/app` is one token to the tokenizer,
    // so both `app` and `repo/app` used to match nothing while the panel's own
    // filter matched them.
    expect(sessionIds(list(db, { query: 'app' }))).toEqual(['1'])
    expect(sessionIds(list(db, { query: 'repo/app' }))).toEqual(['1'])
    expect(sessionIds(list(db, { query: 'needle.jsonl' }))).toEqual(['3'])
  })

  it('matches a branch and an agent', async () => {
    const db = await openIndex()
    seed(db, { id: 1, agent: 'claude', branch: 'feature/vault' })
    seed(db, { id: 2, agent: 'codex', branch: 'main' })

    expect(sessionIds(list(db, { query: 'vault' }))).toEqual(['1'])
    expect(sessionIds(list(db, { query: 'codex' }))).toEqual(['2'])
  })

  it('requires every term, and returns nothing rather than the unfiltered list', async () => {
    const db = await openIndex()
    seed(db, { id: 1, title: 'a conversation about indexing' })
    seed(db, { id: 2, title: 'terminal tabs' })

    expect(sessionIds(list(db, { query: 'conversation indexing' }))).toEqual(['1'])
    // `conversation` alone returns the row, so the extra term is what removed it.
    expect(sessionIds(list(db, { query: 'conversation missing' }))).toEqual([])
    expect(sessionIds(list(db, { query: 'nothingmatchesthis' }))).toEqual([])
    // The unfiltered read still holds both, so the empty results above are the
    // filter and not an empty index.
    expect(sessionIds(list(db))).toEqual(['2', '1'])
  })

  it('composes with scopePaths, agents and the bound', async () => {
    const db = await openIndex()
    seed(db, {
      id: 1,
      agent: 'claude',
      cwd: '/work/app',
      title: 'shared word',
      updatedAt: '2026-09-01T00:00:00.000Z'
    })
    seed(db, {
      id: 2,
      agent: 'codex',
      cwd: '/work/app',
      title: 'shared word',
      updatedAt: '2026-09-02T00:00:00.000Z'
    })
    seed(db, {
      id: 3,
      agent: 'claude',
      cwd: '/other/app',
      title: 'shared word',
      updatedAt: '2026-09-03T00:00:00.000Z'
    })

    expect(sessionIds(list(db, { query: 'shared', scopePaths: ['/work/app'] }))).toEqual(['2', '1'])
    expect(sessionIds(list(db, { query: 'shared', agents: ['claude'] }))).toEqual(['3', '1'])
    const capped = list(db, { query: 'shared', limit: 2 })
    expect(sessionIds(capped)).toEqual(['3', '2'])
    expect(capped.truncated).toBe(true)
    expect(list(db, { query: 'shared', limit: 3 }).truncated).toBe(false)
  })

  it('matches `_` in a term as a literal, not as a one-character wildcard', async () => {
    const db = await openIndex()
    seed(db, { id: 1, title: 'a_b' })
    seed(db, { id: 2, title: 'axb' })
    seed(db, { id: 3, title: 'axxb' })

    // The naive `%a_b%` reads `_` as "any one character" and would take all three.
    expect(sessionIds(list(db, { query: 'a_b' }))).toEqual(['1'])
  })

  it('does not read a lone `%` term as match-everything', async () => {
    const db = await openIndex()
    seed(db, { id: 1, cwd: '/work/100%_done' })
    seed(db, { id: 2, cwd: '/work/1000x_done' })
    seed(db, { id: 3, title: 'no percent here' })

    // Unescaped, `%%%` matches every row including those with no `%` at all.
    expect(sessionIds(list(db, { query: '%' }))).toEqual(['1'])
    // Both wildcards at once, against a literal folder name.
    expect(sessionIds(list(db, { query: '100%_done' }))).toEqual(['1'])
  })
})

describe('the retention cutoff', () => {
  it('dates a row by its file row, so an older file is left out', async () => {
    const db = await openIndex()
    seed(db, { id: 1 })
    seed(db, { id: 2 })
    seed(db, { id: 3 })
    db.prepare(
      "INSERT INTO files(path,byte_offset,mtime_ms,session_row_id) VALUES ('/old',0,100,1)"
    ).run()
    db.prepare(
      "INSERT INTO files(path,byte_offset,mtime_ms,session_row_id) VALUES ('/new',0,500,2)"
    ).run()

    // The cutoff is a subquery over `files`, so a row with no file row is
    // outside every window: nothing dates it and a purge would have nothing to
    // compare against.
    expect(sessionIds(list(db, { retentionCutoffMs: 300 }))).toEqual(['2'])
    expect(sessionIds(list(db, { retentionCutoffMs: null }))).toEqual(['3', '2', '1'])
  })
})

describe('the mapped row', () => {
  it('composes the id, stamps the host, and carries no transcript text', async () => {
    const db = await openIndex()
    seed(db, {
      id: 1,
      agent: 'codex',
      sessionId: 'session-abc',
      filePath: '/transcripts/session-abc.jsonl',
      codexHome: '/codex-home',
      title: 'a title',
      cwd: '/work/app',
      branch: 'main',
      model: 'gpt-5',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      modifiedAt: '2026-09-03T00:00:00.000Z',
      messageCount: 7,
      totalTokens: 42,
      queuedMessageCount: 1,
      subagentTranscriptCount: 2,
      resumeCommand: 'codex resume session-abc'
    })

    const session = list(db).sessions[0]
    expect(session).toMatchObject({
      id: `${LOCAL_EXECUTION_HOST_ID}:codex:session-abc:/transcripts/session-abc.jsonl`,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      agent: 'codex',
      sessionId: 'session-abc',
      filePath: '/transcripts/session-abc.jsonl',
      codexHome: '/codex-home',
      title: 'a title',
      cwd: '/work/app',
      branch: 'main',
      model: 'gpt-5',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      modifiedAt: '2026-09-03T00:00:00.000Z',
      messageCount: 7,
      totalTokens: 42,
      queuedMessageCount: 1,
      subagentTranscriptCount: 2,
      resumeCommand: 'codex resume session-abc',
      previewMessages: []
    })
    // Both prompt fields are transcript text, read on demand for the one session
    // a user opens; a row must not claim to have them and then have nothing.
    expect(Object.hasOwn(session, 'firstUserPrompt')).toBe(false)
    expect(Object.hasOwn(session, 'lastUserPrompt')).toBe(false)
  })

  it('falls back to updated_at for modifiedAt when modified_at is null', async () => {
    const db = await openIndex()
    seed(db, {
      id: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      modifiedAt: null
    })

    expect(list(db).sessions[0]?.modifiedAt).toBe('2026-09-02T00:00:00.000Z')
  })
})
