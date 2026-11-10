import './session-search-worker.test-fixture'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
import type { AiVaultSearchSettings } from '../../shared/ai-vault/search/ai-vault-search-settings'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { searchSessionService, sessionSearchServiceStatus } from './session-search-service-registry'
import { resetSessionSearchPolicyForTests } from './session-search-policy'
import { resetSessionSearchServiceInitForTests } from './session-search-service-init'
import { installInProcessSessionSearchService } from './session-search-in-process-service'

const localAiVaultScanRoots = vi.hoisted(() => vi.fn())
vi.mock('../ai-vault/cached-session-list', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  localAiVaultScanRoots
}))

let harness: SessionSearchIndexerHarness
let installed: { apply?(settings: AiVaultSearchSettings): void; dispose(): void } | null

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('ss-registration')
  installed = null
  localAiVaultScanRoots.mockReset().mockResolvedValue(harness.roots)
})

afterEach(async () => {
  installed?.dispose()
  const { setSessionSearchService } = await import('./session-search-service-registry')
  setSessionSearchService(null)
  resetSessionSearchPolicyForTests()
  resetSessionSearchServiceInitForTests()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

it('registers an in-process service for a host with no scanner child', async () => {
  installed = installInProcessSessionSearchService({
    dataRoot: harness.root,
    roots: harness.roots,
    settings: { contentEnabled: false, historyDays: null }
  })
  expect(installed).not.toBeNull()

  // Content-off, not absent: the caller can tell "this host stores no message
  // bodies" from "this host has no index at all", which is what no-service means.
  // The install applies its settings asynchronously, so an index is live a turn
  // after the install returns rather than inside it.
  await vi.waitFor(async () =>
    expect(await sessionSearchServiceStatus({}, 'relay')).toMatchObject({
      enabled: true,
      contentEnabled: false
    })
  )
  expect(await searchSessionService({ query: 'ledger' }, 'relay')).not.toEqual({
    kind: 'unavailable',
    reason: 'no-service'
  })

  installed?.dispose()
  installed = null
  expect(await searchSessionService({ query: 'ledger' }, 'relay')).toEqual({
    kind: 'unavailable',
    reason: 'no-service'
  })
})

it('orcad indexes metadata without content consent and discovers a late root', async () => {
  const { installOrcadSessionSearchService } = await import('../orcad/orcad-session-search')
  // Content consent is not what starts the index any more: the history list's own
  // rows are indexed regardless, which is why a host reaches for its roots here.
  installed = await installOrcadSessionSearchService({
    userDataPath: harness.root,
    getSettings: () => ({ aiVaultSearch: { contentEnabled: false, historyDays: null } })
  })
  await vi.waitFor(() => expect(localAiVaultScanRoots).toHaveBeenCalled())
  installed?.dispose()
  installed = await installOrcadSessionSearchService({
    userDataPath: harness.root,
    getSettings: () => ({ aiVaultSearch: { contentEnabled: true, historyDays: null } })
  })
  await searchSessionService({ query: 'latehostroot', freshness: 'wait-until-current' }, 'ipc')
  const late = join(harness.root, 'late-claude')
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  await writeClaudeTranscript(join(late, 'project', `${id}.jsonl`), ['latehostroot'], id)
  localAiVaultScanRoots.mockResolvedValue({ ...harness.roots, claudeProjectsDir: late })
  const response = await searchSessionService(
    { query: 'latehostroot', freshness: 'wait-until-current' },
    'ipc'
  )
  expect(response.kind).toBe('results')
  if (response.kind === 'results') {
    expect(response.hits.map((hit) => hit.sessionId)).toEqual([id])
  }
})

// A host with no scanner child has nothing to forward a policy to, so the installed
// service is itself how a settings write reaches the index.
it('re-applies content consent on an in-process host without reinstalling the service', async () => {
  installed = installInProcessSessionSearchService({
    dataRoot: harness.root,
    roots: harness.roots,
    settings: { contentEnabled: false, historyDays: null }
  })
  // Metadata is not a consent decision, so a host with content off still answers — from titles
  // and paths rather than message bodies. `apply` is asynchronous, so each consent
  // write settles a turn after the call.
  await vi.waitFor(async () =>
    expect(await sessionSearchServiceStatus({}, 'relay')).toMatchObject({
      enabled: true,
      contentEnabled: false
    })
  )
  expect(await searchSessionService({ query: 'ledger' }, 'relay')).not.toMatchObject({
    kind: 'unavailable',
    reason: 'disabled'
  })

  installed?.apply?.({ contentEnabled: true, historyDays: null })
  await vi.waitFor(async () =>
    expect(await sessionSearchServiceStatus({}, 'relay')).toMatchObject({
      enabled: true,
      contentEnabled: true
    })
  )

  installed?.apply?.({ contentEnabled: false, historyDays: null })
  await vi.waitFor(async () =>
    expect(await sessionSearchServiceStatus({}, 'relay')).toMatchObject({
      enabled: true,
      contentEnabled: false
    })
  )
})
