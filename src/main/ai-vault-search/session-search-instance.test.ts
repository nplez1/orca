import './session-search-worker.test-fixture'
import { existsSync } from 'node:fs'
import { unlink, utimes } from 'node:fs/promises'
import * as fileRemoval from '../../shared/windows-transient-lock-removal'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import SyncDatabase from '../sqlite/sync-database'
import * as searchSchema from './session-search-schema'
import { SessionSearchReaders } from './session-search-readers'
import { SessionSearchInstance } from './session-search-instance'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

const RECENT_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const ANCIENT_SESSION_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

let harness: SessionSearchIndexerHarness
let instance: SessionSearchInstance | null
let errors: unknown[]

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  errors = []
  harness = await openSessionSearchIndexerHarness('ss-instance')
  instance = null
})

afterEach(async () => {
  vi.restoreAllMocks()
  await instance?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

function newInstance(): SessionSearchInstance {
  instance = new SessionSearchInstance({
    databasePath: harness.databasePath,
    roots: harness.roots,
    onError: (error) => errors.push(error)
  })
  return instance
}

function transcriptPath(sessionId: string): string {
  return join(harness.claudeProjectDir, `${sessionId}.jsonl`)
}

/** Row counts read from the index itself: what the tier is allowed to have kept. */
function tableRowCount(table: 'messages' | 'session_metadata_fts'): number {
  const db = new SyncDatabase(harness.databasePath)
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: COUNT(*) always returns one row with one numeric column.
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    return row.count
  } finally {
    db.close()
  }
}

function messageRowCount(): number {
  return tableRowCount('messages')
}

function sessionFtsRowCount(): number {
  return tableRowCount('session_metadata_fts')
}

async function searchFor(query: string): Promise<string[]> {
  const response = await instance!.search({ query })
  if (response.kind !== 'results') {
    throw new Error(`expected results, got ${response.kind}`)
  }
  return response.hits.map((hit) => hit.sessionId).sort()
}

it('indexes the history list but keeps no conversation text while content is off', async () => {
  await writeClaudeTranscript(
    transcriptPath(RECENT_SESSION_ID),
    ['a conversation'],
    RECENT_SESSION_ID
  )
  const subject = newInstance()
  subject.apply({ contentEnabled: false, historyDays: null })
  await subject.settled()

  // The metadata tier is the history list's own rows, and it runs without a
  // consent decision. Content is what needs one.
  expect(subject.running).toBe(true)
  expect(existsSync(harness.databasePath)).toBe(true)
  expect(subject.status()).toMatchObject({ enabled: true, contentEnabled: false })
  const listed = subject.listSessions({
    limit: 50,
    scopePaths: [],
    executionHostId: LOCAL_EXECUTION_HOST_ID
  })
  expect(listed?.sessions.map((session) => session.sessionId)).toEqual([RECENT_SESSION_ID])
  // Nothing was read for content, so nothing about it is on disk — while the
  // metadata search surface still knows the session exists.
  expect(messageRowCount()).toBe(0)
  expect(sessionFtsRowCount()).toBe(1)

  // Search answers from that same surface: the consent that keeps message bodies
  // out is what routes a query to titles and paths, so it must not come back empty.
  const hits = await subject.search({ query: 'conversation' })
  expect(hits.kind).toBe('results')
  if (hits.kind === 'results') {
    expect(hits.hits.map((hit) => hit.sessionId)).toEqual([RECENT_SESSION_ID])
    expect(hits.hits[0]?.evidence).toBeNull()
  }
  expect(errors).toEqual([])
})

it('reads the transcripts it already holds when content consent is turned on', async () => {
  await writeClaudeTranscript(
    transcriptPath(RECENT_SESSION_ID),
    ['a distinctive conversation'],
    RECENT_SESSION_ID
  )
  const subject = newInstance()
  subject.apply({ contentEnabled: false, historyDays: null })
  await subject.settled()
  expect(messageRowCount()).toBe(0)

  // Consent turned on inside the same profile: the files have not changed, so
  // every row's stat comparison reads as "nothing to do" — and a full-text search
  // over a history whose message rows were never written answers with nothing.
  subject.apply({ contentEnabled: true, historyDays: null })
  await subject.settled()

  expect(messageRowCount()).toBeGreaterThan(0)
  expect(await searchFor('distinctive')).toEqual([RECENT_SESSION_ID])
  expect(errors).toEqual([])
})

it('closes the live pair and starts a new one on a settings change', async () => {
  const recent = transcriptPath(RECENT_SESSION_ID)
  const ancient = transcriptPath(ANCIENT_SESSION_ID)
  await writeClaudeTranscript(recent, ['a recent conversation'], RECENT_SESSION_ID)
  await writeClaudeTranscript(ancient, ['an ancient conversation'], ANCIENT_SESSION_ID)
  const longAgo = new Date(Date.now() - 120 * 86_400_000)
  await utimes(ancient, longAgo, longAgo)

  const subject = newInstance()
  subject.apply({ contentEnabled: true, historyDays: null })
  await subject.settled()
  expect(await searchFor('ancient')).toEqual([ANCIENT_SESSION_ID])

  // Narrowing: the new instance's opening sweep purges what the window no longer covers.
  subject.apply({ contentEnabled: true, historyDays: 30 })
  await subject.settled()
  expect(await searchFor('ancient')).toEqual([])
  expect(await searchFor('recent')).toEqual([RECENT_SESSION_ID])

  // Widening: the same recipe the other way, admitting files no read ever saw.
  subject.apply({ contentEnabled: true, historyDays: null })
  await subject.settled()
  expect(await searchFor('ancient')).toEqual([ANCIENT_SESSION_ID])
  expect(errors).toEqual([])
})

// Closing must release the writer's claim on the path, or nothing can reopen it:
// the second instance would fail to stake it and report no index at all.
it('releases the writer claim when closed so a new instance can open it', async () => {
  await writeClaudeTranscript(
    transcriptPath(RECENT_SESSION_ID),
    ['a conversation'],
    RECENT_SESSION_ID
  )
  const first = newInstance()
  first.apply({ contentEnabled: true, historyDays: null })
  await first.settled()
  expect(first.running).toBe(true)

  first.close()
  expect(first.running).toBe(false)
  // The index is left on disk: closing is not a deletion.
  expect(existsSync(harness.databasePath)).toBe(true)

  const second = newInstance()
  second.apply({ contentEnabled: true, historyDays: null })
  await second.settled()
  expect(second.running).toBe(true)
  expect(await searchFor('conversation')).toEqual([RECENT_SESSION_ID])
  expect(errors).toEqual([])
})

it('removes the database on clear and rebuilds it', async () => {
  await writeClaudeTranscript(
    transcriptPath(RECENT_SESSION_ID),
    ['a distinctive conversation'],
    RECENT_SESSION_ID
  )
  const subject = newInstance()
  subject.apply({ contentEnabled: true, historyDays: null })
  await subject.settled()
  expect(await searchFor('distinctive')).toEqual([RECENT_SESSION_ID])

  await subject.clear()
  expect(subject.running).toBe(true)
  expect(existsSync(harness.databasePath)).toBe(true)
  await subject.settled()
  expect(await searchFor('distinctive')).toEqual([RECENT_SESSION_ID])
  expect(errors).toEqual([])
})

it('never reports the deleted index while re-enabling a cleared search', async () => {
  for (const id of [RECENT_SESSION_ID, ANCIENT_SESSION_ID]) {
    await writeClaudeTranscript(transcriptPath(id), ['searchable conversation'], id)
  }
  const subject = newInstance()
  const initialEnable = subject.apply({ contentEnabled: true, historyDays: null })
  expect(await subject.status()).toMatchObject({
    enabled: true,
    phase: 'indexing',
    filesIndexed: 0,
    messagesIndexed: 0
  })
  await initialEnable
  await subject.settled()
  expect(await subject.status()).toMatchObject({ filesIndexed: 2, messagesIndexed: 4 })

  await subject.apply({ contentEnabled: false, historyDays: null })
  await subject.clear()
  // The fork's clear rebuilds the metadata index at once; what must not survive
  // is the old index's rows, and the status below answers from an absent reader.
  expect(existsSync(harness.databasePath)).toBe(true)
  await unlink(transcriptPath(ANCIENT_SESSION_ID))

  let release!: () => void
  let opening!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    opening = resolve
  })
  const initialize = SessionSearchIndexer.prototype.initialize
  vi.spyOn(SessionSearchIndexer.prototype, 'initialize').mockImplementationOnce(async function (
    this: SessionSearchIndexer
  ) {
    opening()
    await blocked
    await initialize.call(this)
  })
  const enabling = subject.apply({ contentEnabled: true, historyDays: null })
  try {
    await started
    expect(await subject.status()).toMatchObject({
      enabled: true,
      phase: 'indexing',
      filesIndexed: 0,
      messagesIndexed: 0
    })
  } finally {
    release()
    await enabling
  }
  await subject.settled()
  expect(await subject.status()).toMatchObject({ filesIndexed: 1, messagesIndexed: 2 })
  expect(errors).toEqual([])
})

it('refuses a page cursor minted before clear even when the rebuilt generation matches', async () => {
  for (const id of [RECENT_SESSION_ID, ANCIENT_SESSION_ID]) {
    await writeClaudeTranscript(transcriptPath(id), [`shared clear fence ${id}`], id)
  }
  const subject = newInstance()
  subject.apply({ contentEnabled: true, historyDays: null })
  await subject.settled()
  const first = await subject.search({ query: 'shared clear fence', limit: 1 })
  if (first.kind !== 'results' || !first.page.cursor) {
    throw new Error('expected a paged result')
  }

  await subject.clear()
  await subject.settled()
  expect((await subject.status()).generation).toBe(first.generation)
  expect(
    await subject.search({ query: 'shared clear fence', limit: 1, cursor: first.page.cursor })
  ).toMatchObject({ kind: 'stale-cursor', generation: first.generation })
  expect(errors).toEqual([])
})

it('keeps pagination stable when the clock crosses retention before a purge', async () => {
  for (const id of [RECENT_SESSION_ID, ANCIENT_SESSION_ID]) {
    await writeClaudeTranscript(transcriptPath(id), [`distinctive conversation ${id}`], id)
  }
  const subject = newInstance()
  subject.apply({ contentEnabled: true, historyDays: 30 })
  await subject.settled()
  const first = await subject.search({ query: 'distinctive', limit: 1 })
  if (first.kind !== 'results') {
    throw new Error('expected results')
  }
  expect(first.page.cursor).toBeTruthy()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 86_400_000)
  const second = await subject.search({
    query: 'distinctive',
    limit: 1,
    cursor: first.page.cursor!
  })
  if (second.kind !== 'results') {
    throw new Error('expected results')
  }
  expect(second.generation).toBe(first.generation)
  expect(second.hits).toHaveLength(1)
  expect(second.hits[0].sessionId).not.toBe(first.hits[0].sessionId)
  expect(errors).toEqual([])
})

// An unresolvable scope is the host's last word, not its first: consent and
// readiness are what the reader can act on, so they have to answer first. This
// fork always indexes the metadata tier, so "off" is not the absence of an
// index: a scope it cannot resolve stays the scope's fault, not consent's.
it('blames an unknown scope rather than consent with content search off', async () => {
  const subject = newInstance()
  subject.apply({ contentEnabled: false, historyDays: null })
  await subject.settled()

  expect(await subject.search({ query: 'anything' }, { kind: 'unknown' })).toEqual({
    kind: 'unavailable',
    reason: 'scope-unknown'
  })
})

it('propagates query failures while status remains available without a reader', async () => {
  const subject = newInstance()
  await subject.apply({ contentEnabled: true, historyDays: null })
  await subject.settled()
  const before = await subject.status()
  vi.spyOn(SessionSearchReaders.prototype, 'query').mockRejectedValue(new Error('reader failed'))
  await expect(subject.search({ query: 'needle' })).rejects.toThrow('reader failed')
  expect(await subject.status()).toEqual(before)
})

it('rejects a failed clear and keeps the transition chain usable for another clear', async () => {
  const subject = newInstance()
  const remove = vi
    .spyOn(searchSchema, 'removeSessionSearchDatabaseAsync')
    .mockRejectedValueOnce(new Error('unlink denied'))
  await expect(subject.clear()).rejects.toThrow('unlink denied')
  await expect(subject.clear()).resolves.toBeUndefined()
  expect(remove).toHaveBeenCalledTimes(2)
})

it('keeps serving while an asynchronous clear deletion outlives its deadline', async () => {
  const subject = newInstance()
  let reject!: (error: Error) => void
  const blocked = new Promise<void>((_resolve, fail) => {
    reject = fail
  })
  const remove = vi.spyOn(fileRemoval, 'removeTree').mockReturnValue(blocked)
  vi.useFakeTimers()
  try {
    const clear = expect(subject.clear()).rejects.toThrow('Could not complete')
    await vi.advanceTimersByTimeAsync(0)
    expect(remove).toHaveBeenCalled()
    expect(await subject.status()).toMatchObject({ enabled: false })
    await vi.advanceTimersByTimeAsync(10_000)
    await clear
    // No index was ever applied on this subject, so the reader reports readiness,
    // not the disabled reason upstream's settings model would produce.
    expect(await subject.search({ query: 'responsive' })).toMatchObject({ reason: 'not-ready' })
    reject(new Error('file remains locked'))
    await subject.close()
    expect(errors).toContainEqual(new Error('file remains locked'))
  } finally {
    vi.useRealTimers()
    remove.mockRestore()
  }
})
