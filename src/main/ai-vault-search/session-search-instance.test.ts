import './worker/session-search-worker.test-fixture'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'
import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchInstance } from './session-search-instance'
import type { IndexedSessionListArgs } from './session-search-list'
import { readSessionSearchContentConsent } from './storage/session-search-store'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './indexing/session-search-indexer-test-fixture'

/**
 * The instance runs on orcad's event loop, so its SQL goes through the worker threads: consent
 * through the writer, the list through the readers.
 */

const IN_SCOPE = '11111111-1111-4111-8111-111111111111'
const ELSEWHERE = '22222222-2222-4222-8222-222222222222'

let harness: SessionSearchIndexerHarness
let instance: SessionSearchInstance | null

beforeEach(async () => {
  harness = await openSessionSearchIndexerHarness('ss-instance')
  instance = null
})

afterEach(async () => {
  await instance?.close()
  await harness.cleanup()
})

function recordedConsent(): boolean {
  const db = new SyncDatabase(harness.databasePath, { readonly: true, fileMustExist: true })
  try {
    return readSessionSearchContentConsent(db)
  } finally {
    db.close()
  }
}

it('records each applied consent in the index before the instance reports it live', async () => {
  instance = new SessionSearchInstance({
    databasePath: harness.databasePath,
    roots: harness.roots
  })

  instance.apply({ contentEnabled: false, historyDays: null })
  await instance.settled()
  expect(recordedConsent()).toBe(false)
  expect((await instance.status()).contentEnabled).toBe(false)

  instance.apply({ contentEnabled: true, historyDays: null })
  await instance.settled()
  expect(recordedConsent()).toBe(true)
  expect((await instance.status()).contentEnabled).toBe(true)
})

async function openListedInstance(): Promise<SessionSearchInstance> {
  await writeClaudeTranscript(
    join(harness.claudeProjectDir, `${IN_SCOPE}.jsonl`),
    ['the older, in-scope conversation'],
    IN_SCOPE,
    { cwd: '/repo/app' }
  )
  await writeClaudeTranscript(
    join(harness.claudeProjectDir, `${ELSEWHERE}.jsonl`),
    ['the newer conversation somewhere else'],
    ELSEWHERE,
    { cwd: '/other/place', startIndex: 10 }
  )
  const opened = new SessionSearchInstance({
    databasePath: harness.databasePath,
    roots: harness.roots,
    onError: () => undefined
  })
  opened.apply({ contentEnabled: false, historyDays: null })
  await opened.settled()
  return opened
}

const page = (limit: number, scopePaths: string[] = []): IndexedSessionListArgs => ({
  limit,
  scopePaths,
  executionHostId: LOCAL_EXECUTION_HOST_ID
})

it('answers each requested page from one reader request', async () => {
  instance = await openListedInstance()

  const pages = await instance.listSessions([page(1), page(1, ['/repo/app'])])

  // The capped page keeps the newest row; the scoped page finds the older one the cap dropped.
  expect(pages?.map((list) => list.sessions.map((session) => session.sessionId))).toEqual([
    [ELSEWHERE],
    [IN_SCOPE]
  ])
  expect(pages?.map((list) => list.truncated)).toEqual([true, false])
})

it('falls back to the scanner when a settings change retires the readers mid-list', async () => {
  instance = await openListedInstance()

  const listing = instance.listSessions([page(50)])
  // Closes the live readers synchronously, which fails the request already in flight.
  void instance.apply({ contentEnabled: true, historyDays: null })

  await expect(listing).resolves.toBeNull()
})
