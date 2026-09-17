import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AiVaultSearchResponse, AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import { SessionSearchIndexer } from '../ai-vault-search/session-search-indexer'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from '../ai-vault-search/session-search-indexer-test-fixture'
import { SessionSearchInstance } from '../ai-vault-search/session-search-instance'
import { SessionScannerServiceSearch } from './session-scanner-service-search'
import type { AiVaultWorkerScanOptions } from './session-scanner-worker-protocol'
import {
  AI_VAULT_SERVICE_PROTOCOL_VERSION,
  type AiVaultServiceChildMessage,
  type AiVaultServiceParentMessage,
  type AiVaultServiceRequestBody,
  type AiVaultServiceResultValue,
  type AiVaultSessionSearchInit
} from './session-scanner-service-protocol'

/**
 * The child, booted the way a spawn boots it: an init frame and messages, with
 * no renderer, no Electron and no scan request. What this proves is that consent
 * alone constructs the indexer and that every search answer crosses the protocol.
 */

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let harness: SessionSearchIndexerHarness
let currentRoots: SessionSearchIndexerHarness['roots']
let originalSend: typeof process.send
const sent: AiVaultServiceChildMessage[] = []
let nextId = 1

function emit(message: AiVaultServiceParentMessage): void {
  process.emit('message', message, undefined)
}

/** One request, and the reply the child sent for it, still discriminated by operation. */
async function call(body: AiVaultServiceRequestBody): Promise<AiVaultServiceResultValue> {
  const id = nextId++
  emit({ ...body, id })
  const reply = await vi.waitFor(() => {
    const found = sent.find(
      (message) => (message.type === 'result' || message.type === 'error') && message.id === id
    )
    expect(found).toBeDefined()
    return found!
  })
  if (reply.type === 'error') {
    throw new Error(reply.message)
  }
  if (reply.type !== 'result') {
    throw new Error(`expected a result, got ${reply.type}`)
  }
  return reply
}

async function searchStatus(): Promise<AiVaultSearchStatus> {
  const reply = await call({ type: 'request', operation: 'searchStatus' })
  if (reply.operation !== 'searchStatus') {
    throw new Error(`expected searchStatus, got ${reply.operation}`)
  }
  return reply.value
}

async function searchSessions(query: string): Promise<AiVaultSearchResponse> {
  const reply = await call({ type: 'request', operation: 'searchSessions', request: { query } })
  if (reply.operation !== 'searchSessions') {
    throw new Error(`expected searchSessions, got ${reply.operation}`)
  }
  return reply.value
}

function searchInit(contentEnabled: boolean): AiVaultSessionSearchInit {
  return {
    databasePath: harness.databasePath,
    settings: { contentEnabled, historyDays: null },
    roots: harness.roots
  }
}

beforeAll(async () => {
  harness = await openSessionSearchIndexerHarness('ss-child')
  currentRoots = harness.roots
  await writeClaudeTranscript(
    join(harness.claudeProjectDir, `${SESSION_ID}.jsonl`),
    ['a distinctive conversation'],
    SESSION_ID
  )
  originalSend = process.send
  const record: NonNullable<typeof process.send> = (message) => {
    sent.push(message)
    if (message.type === 'sessionSearchRoots') {
      queueMicrotask(() =>
        emit({ type: 'sessionSearchRoots', id: message.id, roots: currentRoots })
      )
    }
    return true
  }
  process.send = record
  await import('./session-scanner-service-entry')
  emit({
    type: 'init',
    protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION,
    sessionParseCache: null,
    sessionSearch: searchInit(true)
  })
  await vi.waitFor(() => expect(sent.some((message) => message.type === 'ready')).toBe(true))
})

afterAll(async () => {
  emit({ type: 'sessionSearch', init: searchInit(false) })
  process.send = originalSend
  await harness.cleanup()
})

it('reports the indexer phase and a live generation over the protocol', async () => {
  const status = await vi.waitFor(async () => {
    const value = await searchStatus()
    expect(value.filesIndexed).toBeGreaterThan(0)
    return value
  })
  expect(status.enabled).toBe(true)
  expect(status.phase).toBe('current')
  expect(status.generation).toBeGreaterThan(0)
  expect(existsSync(harness.databasePath)).toBe(true)
})

it('answers a search and a reconcile over the protocol', async () => {
  expect(await call({ type: 'request', operation: 'searchReconcile' })).toEqual({
    operation: 'searchReconcile',
    value: null,
    type: 'result',
    id: expect.any(Number)
  })
  const response = await searchSessions('distinctive')
  expect(response.kind).toBe('results')
  if (response.kind === 'results') {
    expect(response.hits.map((hit) => hit.sessionId)).toEqual([SESSION_ID])
  }
})

it('discovers a new root through the parent exchange on manual reconciliation', async () => {
  const lateHome = join(harness.root, 'late-home')
  const id = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  await writeClaudeTranscript(
    join(lateHome, '.claude', 'projects', 'late', `${id}.jsonl`),
    ['freshroots'],
    id
  )
  currentRoots = { ...harness.roots, wslHomeDirs: [lateHome] }
  await call({ type: 'request', operation: 'searchReconcile' })
  const response = await searchSessions('freshroots')
  expect(response.kind).toBe('results')
  if (response.kind === 'results') {
    expect(response.hits.map((hit) => hit.sessionId)).toEqual([id])
  }
})

it('clears the owned index and rebuilds from the transcripts still on disk', async () => {
  const transcriptPath = join(harness.claudeProjectDir, `${SESSION_ID}.jsonl`)
  expect((await searchSessions('distinctive')).kind).toBe('results')
  rmSync(transcriptPath)

  expect(await call({ type: 'request', operation: 'searchClear' })).toEqual({
    operation: 'searchClear',
    value: null,
    type: 'result',
    id: expect.any(Number)
  })
  expect(await searchSessions('distinctive')).toMatchObject({ kind: 'results', hits: [] })
  expect(existsSync(harness.databasePath)).toBe(true)
})

it('withdraws content consent without a respawn and keeps answering', async () => {
  emit({ type: 'sessionSearch', init: searchInit(false) })
  // The metadata index is not a consent decision, so search still answers — it
  // matches titles and paths rather than message bodies. What the withdrawal
  // stops is content being stored at all.
  expect(await searchStatus()).toMatchObject({ enabled: true, contentEnabled: false })
  expect((await searchSessions('distinctive')).kind).not.toBe('unavailable')
  // Re-consenting reuses the index that was left on disk rather than rebuilding it.
  emit({ type: 'sessionSearch', init: searchInit(true) })
  expect((await searchSessions('distinctive')).kind).toBe('results')
})

/**
 * `SessionScannerServiceSearch.listSessions` on its own index.
 *
 * Driven directly rather than over the IPC harness above because one process
 * allows one live indexer per database path, and the child already owns that
 * one. What these pin is the fallback contract the entry relies on: null means
 * "run the scanner", a completed pass means "read the index".
 */

const LISTED_SESSION_ID = 'cccccccc-dddd-4eee-8fff-111111111111'
const LATE_SESSION_ID = 'dddddddd-eeee-4fff-8aaa-222222222222'
const INDEX_ONLY_SESSION_ID = 'eeeeeeee-ffff-4000-8bbb-333333333333'

let listHarness: {
  harness: SessionSearchIndexerHarness
  service: SessionScannerServiceSearch
} | null = null

afterEach(async () => {
  vi.restoreAllMocks()
  listHarness?.service.close()
  await listHarness?.harness.cleanup()
  listHarness = null
})

async function openListService(
  prepare: (harness: SessionSearchIndexerHarness) => Promise<void> = async () => undefined
): Promise<{ harness: SessionSearchIndexerHarness; service: SessionScannerServiceSearch }> {
  const harness = await openSessionSearchIndexerHarness('ss-service-list')
  // Before `apply()`, so the opening sweep cannot miss what the test wrote.
  await prepare(harness)
  const service = new SessionScannerServiceSearch()
  service.apply({
    databasePath: harness.databasePath,
    settings: { contentEnabled: true, historyDays: null },
    roots: harness.roots
  })
  listHarness = { harness, service }
  return listHarness
}

function listOptions(overrides: Partial<AiVaultWorkerScanOptions> = {}): AiVaultWorkerScanOptions {
  return { limit: 50, scopePaths: [], executionHostId: LOCAL_EXECUTION_HOST_ID, ...overrides }
}

async function listStatus(service: SessionScannerServiceSearch): Promise<AiVaultSearchStatus> {
  const reply = await service.execute({ type: 'request', operation: 'searchStatus', id: 0 })
  if (reply.operation !== 'searchStatus') {
    throw new Error(`expected searchStatus, got ${reply.operation}`)
  }
  return reply.value
}

async function waitForCompletedSweep(service: SessionScannerServiceSearch): Promise<void> {
  await vi.waitFor(async () => {
    expect((await listStatus(service)).lastSweepCompletedAt).not.toBeNull()
  })
}

/** A row only SQLite could produce, which is what makes an index answer provable. */
function seedIndexOnlySession(harness: SessionSearchIndexerHarness, sessionId: string): void {
  harness.write((db) =>
    db
      .prepare(
        `INSERT INTO sessions(agent,session_id,file_path,title,updated_at,resume_command)
         VALUES ('claude',?,'','index only','2099-01-01T00:00:00.000Z','')`
      )
      .run(sessionId)
  )
}

function requireList(listed: AiVaultListResult | null): AiVaultListResult {
  if (listed === null) {
    throw new Error('a completed sweep means the list must come from the index')
  }
  return listed
}

function listedSessionIds(listed: AiVaultListResult): string[] {
  return listed.sessions.map((session) => session.sessionId)
}

it('answers the list from the index once a pass has completed', async () => {
  const { harness, service } = await openListService(async (opened) => {
    await writeClaudeTranscript(
      join(opened.claudeProjectDir, `${LISTED_SESSION_ID}.jsonl`),
      ['a listed conversation'],
      LISTED_SESSION_ID
    )
  })
  await waitForCompletedSweep(service)
  seedIndexOnlySession(harness, INDEX_ONLY_SESSION_ID)

  const listed = requireList(await service.listSessions(listOptions(), false))

  expect(listed.issues).toEqual([])
  expect(Number.isFinite(Date.parse(listed.scannedAt))).toBe(true)
  // The seeded row has no file behind it, so finding it here is the proof this
  // answer was a read of the index rather than a walk of the filesystem.
  expect(listedSessionIds(listed)).toContain(INDEX_ONLY_SESSION_ID)
  expect(listedSessionIds(listed)).toContain(LISTED_SESSION_ID)
})

it('answers null until a pass has completed, then answers even with no sessions', async () => {
  const { service } = await openListService()

  // `apply()` queues the first sweep and that sweep reads the filesystem, so
  // nothing can have completed in this turn.
  expect(await service.listSessions(listOptions(), false)).toBeNull()

  await waitForCompletedSweep(service)
  // The gate is a finished pass and not rows: a host with no sessions indexes no
  // file and would otherwise be stranded on the scanner for good.
  expect(await service.listSessions(listOptions(), false)).toEqual({
    sessions: [],
    issues: [],
    scannedAt: expect.any(String)
  })
})

it('reconciles before listing only when refresh asks it to', async () => {
  const { harness, service } = await openListService(async (opened) => {
    await writeClaudeTranscript(
      join(opened.claudeProjectDir, `${LISTED_SESSION_ID}.jsonl`),
      ['a listed conversation'],
      LISTED_SESSION_ID
    )
  })
  await waitForCompletedSweep(service)
  await writeClaudeTranscript(
    join(harness.claudeProjectDir, `${LATE_SESSION_ID}.jsonl`),
    ['written after the sweep'],
    LATE_SESSION_ID
  )
  const reconcile = vi.spyOn(SessionSearchIndexer.prototype, 'reconcile')

  const stale = requireList(await service.listSessions(listOptions(), false))
  expect(reconcile).not.toHaveBeenCalled()
  // The transcript is on disk and the index has never seen it, which is what a
  // filesystem walk would have found and this read did not.
  expect(listedSessionIds(stale)).not.toContain(LATE_SESSION_ID)

  const refreshed = requireList(await service.listSessions(listOptions(), true))
  expect(reconcile).toHaveBeenCalledWith({ full: true })
  expect(listedSessionIds(refreshed)).toContain(LATE_SESSION_ID)
})

it('maps the scan depth onto the index bound and passes the scope through', async () => {
  const { service } = await openListService()
  await waitForCompletedSweep(service)
  const args = vi.spyOn(SessionSearchInstance.prototype, 'listSessions')

  await service.listSessions(listOptions({ limit: 3, scopePaths: ['/work/app'] }), false)
  expect(args).toHaveBeenLastCalledWith({
    limit: 3,
    scopePaths: ['/work/app'],
    executionHostId: LOCAL_EXECUTION_HOST_ID
  })

  // `unlimited` is the panel's own depth, and the index reads it as no bound.
  await service.listSessions(listOptions({ unlimited: true }), false)
  expect(args).toHaveBeenLastCalledWith({
    limit: Number.POSITIVE_INFINITY,
    scopePaths: [],
    executionHostId: LOCAL_EXECUTION_HOST_ID
  })
})

it('answers null with a query before a pass completes, leaving the filter to the caller', async () => {
  const { service } = await openListService()

  // Null and not an empty list: the scanner fallback owns the query (the entry's
  // `filteredScanResult`), and answering empty here would read as "no matches".
  expect(await service.listSessions(listOptions(), false, 'anything')).toBeNull()
})

it('forwards the query into the index read only when there is one', async () => {
  const { service } = await openListService()
  await waitForCompletedSweep(service)
  const args = vi.spyOn(SessionSearchInstance.prototype, 'listSessions')

  await service.listSessions(listOptions(), false, 'vault')
  expect(args).toHaveBeenLastCalledWith({
    limit: 50,
    scopePaths: [],
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    query: 'vault'
  })

  // Absent, not empty: there is no filter to apply and the key is not sent at all.
  await service.listSessions(listOptions(), false)
  expect(args).toHaveBeenLastCalledWith({
    limit: 50,
    scopePaths: [],
    executionHostId: LOCAL_EXECUTION_HOST_ID
  })
})

it('filters the index listing by the query', async () => {
  const { harness, service } = await openListService(async (opened) => {
    await writeClaudeTranscript(
      join(opened.claudeProjectDir, `${LISTED_SESSION_ID}.jsonl`),
      ['a listed conversation'],
      LISTED_SESSION_ID
    )
  })
  await waitForCompletedSweep(service)
  seedIndexOnlySession(harness, INDEX_ONLY_SESSION_ID)

  // The seeded row's title is the only place this text appears.
  const listed = requireList(await service.listSessions(listOptions(), false, 'index only'))
  expect(listedSessionIds(listed)).toEqual([INDEX_ONLY_SESSION_ID])
})
