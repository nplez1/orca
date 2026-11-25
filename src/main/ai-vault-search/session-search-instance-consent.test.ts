import './worker/session-search-worker.test-fixture'
import { afterEach, beforeEach, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchInstance } from './session-search-instance'
import { readSessionSearchContentConsent } from './storage/session-search-store'
import {
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from './indexing/session-search-indexer-test-fixture'

/**
 * The instance runs on orcad's event loop, so it records consent through the writer
 * thread instead of its own connection; the readers and the next writer read it from the rows.
 */

let harness: SessionSearchIndexerHarness
let instance: SessionSearchInstance | null

beforeEach(async () => {
  harness = await openSessionSearchIndexerHarness('ss-instance-consent')
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
