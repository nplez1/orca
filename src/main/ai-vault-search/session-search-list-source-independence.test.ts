import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { scanAiVaultSessions } from '../ai-vault/session-scanner'
import { SessionScannerServiceSearch } from '../ai-vault/session-scanner-service-search'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { SessionSearchInstance } from './session-search-instance'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

/**
 * The list must be answerable without touching a transcript.
 *
 * A row's presence in the index is what the panel renders; the alternative is a
 * walk and a parse of every transcript on the machine, which is the cost this
 * whole path exists to remove. So the proof is not a spy on the reader — it is
 * deleting the transcript and still getting the row back, while the scanner,
 * asked the same question, finds nothing because there is nothing left to read.
 */

const SESSION_ID = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa'

let harness: SessionSearchIndexerHarness
let instance: SessionSearchInstance | null

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('ss-source-independent')
  instance = null
})

afterEach(async () => {
  instance?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

it('answers a list from the index after the transcript is gone', async () => {
  const transcript = join(harness.claudeProjectDir, `${SESSION_ID}.jsonl`)
  await writeClaudeTranscript(transcript, ['a conversation worth listing'], SESSION_ID)

  instance = new SessionSearchInstance({
    databasePath: harness.databasePath,
    roots: harness.roots
  })
  instance.apply({ contentEnabled: false, historyDays: null })
  await instance.settled()

  const listArgs = {
    limit: 50,
    scopePaths: [],
    executionHostId: LOCAL_EXECUTION_HOST_ID
  } as const
  expect(instance.listSessions(listArgs)?.sessions.map((session) => session.sessionId)).toEqual([
    SESSION_ID
  ])

  await rm(transcript)

  // The scanner reads disk, so it now has nothing to say...
  const scanned = await scanAiVaultSessions({ ...harness.roots, platform: 'darwin' })
  expect(scanned.sessions.map((session) => session.sessionId)).not.toContain(SESSION_ID)
  // ...while the index still answers, which is only possible if it never read.
  expect(instance.listSessions(listArgs)?.sessions.map((session) => session.sessionId)).toEqual([
    SESSION_ID
  ])
})

it('serves preview turns from the parse cache rather than the transcript', async () => {
  const transcript = join(harness.claudeProjectDir, `${SESSION_ID}.jsonl`)
  await writeClaudeTranscript(transcript, ['a distinctive opening turn'], SESSION_ID)

  const child = new SessionScannerServiceSearch()
  child.apply({
    databasePath: harness.databasePath,
    roots: harness.roots,
    settings: { contentEnabled: true, historyDays: null }
  })
  // The first list reconciles, which is what decodes the session into the cache.
  const first = await child.listSessions({ platform: 'darwin', limit: 50, scopePaths: [] }, true)
  expect(first?.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID])
  const previews = first?.sessions[0]?.previewMessages ?? []
  expect(previews.map((message) => message.text)).toContain('a distinctive opening turn')

  // The text must not have come from disk on the second read: the transcript is
  // gone, and the row still carries its turns.
  await rm(transcript)
  const second = await child.listSessions({ platform: 'darwin', limit: 50, scopePaths: [] }, false)
  expect(second?.sessions[0]?.previewMessages.map((message) => message.text)).toContain(
    'a distinctive opening turn'
  )
  child.close()
})
