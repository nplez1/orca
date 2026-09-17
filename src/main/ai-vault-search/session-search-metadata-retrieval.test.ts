import { afterEach, describe, expect, it } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'
import { SessionSearchFileRecords } from './session-search-file-records'
import { SessionSearchCursorError } from './session-search-page-cursor'

let harness: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

async function open(name: string, options = {}): Promise<SessionSearchHarness> {
  harness = await openSessionSearchHarness(name, options)
  return harness
}

/** The content tier's off state: metadata rows exist, message rows never will. */
function openWithoutContent(name: string, options = {}): Promise<SessionSearchHarness> {
  return open(name, { contentEnabled: false, ...options })
}

type MetadataSession = {
  id: number
  title?: string
  cwd?: string
  branch?: string | null
  agent?: string
  updatedAt?: string
  text?: string
  filePath?: string | null
}

/**
 * A session the metadata tier can answer for. Written through the writer's own
 * mirror so the test proves the reader agrees with what the indexer stores,
 * rather than with a copy of its SQL pasted into a test.
 */
function addMetadataSession(db: SyncDatabase, session: MetadataSession): void {
  addSyntheticSession(db, {
    id: session.id,
    cwd: session.cwd ?? '/repo/app',
    agent: session.agent ?? 'claude',
    text: session.text ?? 'body only prose',
    updatedAt: session.updatedAt,
    filePath: session.filePath
  })
  // `addSyntheticSession` writes a fixed title and no branch; both are metadata
  // the tier under test reads, so they are set before the FTS row is mirrored.
  db.prepare('UPDATE sessions SET title = ?, branch = ? WHERE id = ?').run(
    session.title ?? 'fixture',
    session.branch ?? null,
    session.id
  )
  new SessionSearchFileRecords(db).refreshSessionFts(session.id)
}

function ids(result: { hits: { sessionId: string }[] }): string[] {
  return result.hits.map((hit) => hit.sessionId)
}

describe('with content off, a text query is answered from the metadata tier', () => {
  it('matches a session by its title alone, with no evidence to show', async () => {
    const { db, engine } = await openWithoutContent('ss-meta-title')
    addMetadataSession(db, { id: 1, title: 'harbor pilot manifest' })
    const result = engine.search({ query: 'harbor' })
    expect(ids(result)).toEqual(['1'])
    // A metadata hit has no message behind it, so there is nothing to snippet.
    expect(result.hits[0]?.evidence).toBeNull()
    expect(result.planner.route).toBe('or')
  })

  it('matches a session by its cwd', async () => {
    const { db, engine } = await openWithoutContent('ss-meta-cwd')
    addMetadataSession(db, { id: 1, cwd: '/work/target' })
    addMetadataSession(db, { id: 2, cwd: '/work/other' })
    // A path tokenizes whole, slashes included, so the query is the whole token.
    expect(ids(engine.search({ query: '/work/target' }))).toEqual(['1'])
  })

  it('matches a session by its branch', async () => {
    const { db, engine } = await openWithoutContent('ss-meta-branch')
    addMetadataSession(db, { id: 1, branch: 'release-2026' })
    addMetadataSession(db, { id: 2, branch: 'release-2025' })
    expect(ids(engine.search({ query: 'release-2026' }))).toEqual(['1'])
  })

  it('matches a session by its agent', async () => {
    const { db, engine } = await openWithoutContent('ss-meta-agent')
    addMetadataSession(db, { id: 1, agent: 'codex' })
    addMetadataSession(db, { id: 2, agent: 'claude' })
    expect(ids(engine.search({ query: 'codex' }))).toEqual(['1'])
  })

  it('returns nothing for text that exists only in message bodies', async () => {
    const { db, engine } = await openWithoutContent('ss-meta-body-only')
    addMetadataSession(db, { id: 1, text: 'hydration marmoset appears here' })
    const result = engine.search({ query: 'marmoset' })
    // The proof that the content tier is not being read: the word is in the
    // index, and the metadata tier still cannot answer for it.
    expect(result.hits).toEqual([])
    expect(result.truncated.candidates).toBe(false)
  })

  it('folds the same query into the same route as the content path would', async () => {
    const { db, engine } = await openWithoutContent('ss-meta-route')
    addMetadataSession(db, { id: 1, title: 'harbor pilot manifest' })
    addMetadataSession(db, { id: 2, title: 'manifest of the harbor' })
    // The content path's own ladder, rung for rung, on the same input.
    expect(engine.search({ query: '"harbor pilot"' }).planner.route).toBe('phrase')
    expect(engine.search({ query: '"pilot harbor"' }).planner.route).toBe('and')
    expect(engine.search({ query: 'harbor manifest' }).planner.route).toBe('or')
    expect(engine.search({ query: 'harbor pilot', scope: 'conversation' }).planner.tier).toBe(
      'conversation'
    )
  })
})

describe('with content off, the filters still narrow retrieval', () => {
  it('narrows by scope path and by agent', async () => {
    const { db, engine } = await openWithoutContent('ss-meta-filters')
    addMetadataSession(db, { id: 1, title: 'harbor one', cwd: '/work/target', agent: 'claude' })
    addMetadataSession(db, { id: 2, title: 'harbor two', cwd: '/work/other', agent: 'codex' })
    expect(
      ids(engine.search({ query: 'harbor', filters: { scopePaths: ['/work/target'] } }))
    ).toEqual(['1'])
    expect(ids(engine.search({ query: 'harbor', filters: { agents: ['codex'] } }))).toEqual(['2'])
  })

  it('applies a repo: operator over the rows it retrieved', async () => {
    const { db, engine } = await openWithoutContent('ss-meta-operators')
    addMetadataSession(db, { id: 1, title: 'harbor one', cwd: '/work/target' })
    addMetadataSession(db, { id: 2, title: 'harbor two', cwd: '/work/other' })
    expect(ids(engine.search({ query: 'harbor repo:target' }))).toEqual(['1'])
  })

  it('excludes what the retention cutoff does not cover', async () => {
    // The cutoff is a `files.mtime_ms` bound, and a session with no file record
    // is not covered by it either: both are the retention policy's own answer.
    const { db, engine } = await openWithoutContent('ss-meta-retention', {
      retentionCutoffMs: 1740000000000
    })
    addMetadataSession(db, { id: 1, title: 'harbor with file' })
    addMetadataSession(db, { id: 2, title: 'harbor without file', filePath: null })
    expect(ids(engine.search({ query: 'harbor' }))).toEqual(['1'])
  })

  it('excludes everything once the cutoff passes the indexed mtime', async () => {
    const { db, engine } = await openWithoutContent('ss-meta-retention-all', {
      retentionCutoffMs: 1740000000001
    })
    addMetadataSession(db, { id: 1, title: 'harbor with file' })
    expect(engine.search({ query: 'harbor' }).hits).toEqual([])
  })

  it('excludes what a since filter does not cover', async () => {
    const { db, engine } = await openWithoutContent('ss-meta-since')
    addMetadataSession(db, { id: 1, title: 'harbor old', updatedAt: '2026-09-01T00:00:00.000Z' })
    addMetadataSession(db, { id: 2, title: 'harbor new', updatedAt: '2026-09-09T00:00:00.000Z' })
    expect(
      ids(engine.search({ query: 'harbor', filters: { since: '2026-09-05T00:00:00.000Z' } }))
    ).toEqual(['2'])
  })
})

describe('with content off, paging walks the metadata ranking', () => {
  async function withTitles(titles: readonly string[]): Promise<SessionSearchHarness> {
    const opened = await openWithoutContent('ss-meta-paging')
    titles.forEach((title, index) => {
      addMetadataSession(opened.db, {
        id: index + 1,
        title,
        updatedAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
      })
    })
    return opened
  }

  it('hands out the rest of the same order on page two', async () => {
    const { engine } = await withTitles([
      'harbor alpha',
      'harbor beta',
      'harbor gamma',
      'harbor delta'
    ])
    const whole = ids(engine.search({ query: 'harbor', limit: 10 }))
    const first = engine.search({ query: 'harbor', limit: 2 })
    const second = engine.search({ query: 'harbor', limit: 2, cursor: first.page.cursor! })
    expect([...ids(first), ...ids(second)]).toEqual(whole)
    expect(second.page.hasMore).toBe(false)
  })

  it('walks every match exactly once when every score ties', async () => {
    // Identical titles and timestamps tie on bm25 and on `updated_at`, so the
    // `id DESC` tiebreak is the only thing making the order total. Without it
    // two entries could swap between pages and one be handed out twice.
    const { engine } = await withTitles(Array.from({ length: 6 }, () => 'harbor'))
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page = engine.search({ query: 'harbor', limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...ids(page))
      cursor = page.page.cursor
    } while (cursor !== null)
    expect(seen).toEqual(['6', '5', '4', '3', '2', '1'])
  })

  it('refuses a cursor minted for a different query', async () => {
    const { engine } = await withTitles(['harbor alpha', 'harbor beta', 'harbor gamma'])
    const first = engine.search({ query: 'harbor', limit: 2 })
    try {
      engine.search({ query: 'alpha', limit: 2, cursor: first.page.cursor! })
      expect.unreachable('a cursor indexes into one ranked list, not any list')
    } catch (error) {
      expect(error).toBeInstanceOf(SessionSearchCursorError)
      expect(error).toMatchObject({ rejection: 'different-query' })
    }
    // The refusal did not cost the cursor its own query.
    expect(
      ids(engine.search({ query: 'harbor', limit: 2, cursor: first.page.cursor! }))
    ).toHaveLength(1)
  })
})

describe('with content on, the metadata table is never consulted', () => {
  it('still misses a title-only query, and answers a body one with evidence', async () => {
    const { db, engine } = await open('ss-meta-content-on', { contentEnabled: true })
    addMetadataSession(db, { id: 1, title: 'harbor pilot manifest', text: 'marmoset in the body' })
    // The metadata row exists and names `harbor`, and the content path must not
    // start reading it: this is the no-change guard for the tier split.
    expect(engine.search({ query: 'harbor' }).hits).toEqual([])
    const body = engine.search({ query: 'marmoset' })
    expect(ids(body)).toEqual(['1'])
    expect(body.hits[0]?.evidence?.snippet).toContain('marmoset')
  })

  it('answers the same as an engine that was not told about the tier at all', async () => {
    // Both handles are held at once, so this is a comparison of two engines and
    // not of one engine with itself. The default has to stay the content tier.
    const explicit = await openSessionSearchHarness('ss-meta-content-explicit', {
      contentEnabled: true
    })
    const defaulted = await openSessionSearchHarness('ss-meta-content-default')
    try {
      for (const opened of [explicit, defaulted]) {
        addMetadataSession(opened.db, {
          id: 1,
          title: 'harbor pilot',
          text: 'marmoset in the body'
        })
      }
      const told = explicit.engine.search({ query: 'marmoset' })
      const untold = defaulted.engine.search({ query: 'marmoset' })
      expect(ids(told)).toEqual(ids(untold))
      expect(told.planner.route).toBe(untold.planner.route)
      expect(told.hits[0]?.evidence?.snippet).toBe(untold.hits[0]?.evidence?.snippet)
    } finally {
      await defaulted.close()
      await explicit.close()
    }
  })
})
