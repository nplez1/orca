import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type { AiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import { installInProcessSessionSearchService } from './session-search-in-process-service'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { searchSessionService, sessionSearchServiceStatus } from './session-search-service-registry'
import { resetSessionSearchPolicyForTests } from './session-search-policy'
import { resetSessionSearchServiceInitForTests } from './session-search-service-init'

/**
 * Every host that answers a search has to register a service, or its answer is
 * `no-service` — which means "this host does not have the feature", not "it is
 * off". Two halves: the installers really register, and each host's boot module
 * really calls the installer that suits it.
 */

const updateSessionSearchInService = vi.hoisted(() => vi.fn())
vi.mock('../ai-vault/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updateSessionSearchInService
}))

const localAiVaultScanRoots = vi.hoisted(() => vi.fn())
vi.mock('../ai-vault/cached-session-list', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  localAiVaultScanRoots
}))

const ROOT = join(import.meta.dirname, '..', '..', '..')

let harness: SessionSearchIndexerHarness
let installed: { apply?(settings: AiVaultSearchSettings): void; dispose(): void } | null

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  updateSessionSearchInService.mockClear()
  harness = await openSessionSearchIndexerHarness('ss-registration')
  installed = null
  localAiVaultScanRoots.mockReset().mockResolvedValue(harness.roots)
})

afterEach(async () => {
  installed?.dispose()
  vi.useRealTimers()
  const { setSessionSearchService } = await import('./session-search-service-registry')
  setSessionSearchService(null)
  resetSessionSearchPolicyForTests()
  resetSessionSearchServiceInitForTests()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

it('answers no-service until a host registers one', async () => {
  expect(await searchSessionService({ query: 'ledger' }, 'ipc')).toEqual({
    kind: 'unavailable',
    reason: 'no-service'
  })
})

it('registers the desktop service and pushes the stored policy at boot', async () => {
  const { installChildSessionSearchService } = await import('./session-search-enablement')
  installed = installChildSessionSearchService({
    dataRoot: harness.root,
    getSettings: () => ({ aiVaultSearch: { contentEnabled: true, historyDays: 30 } })
  })

  expect(await searchSessionService({ query: 'ledger' }, 'ipc')).not.toEqual({
    kind: 'unavailable',
    reason: 'no-service'
  })
  await vi.waitFor(() => expect(updateSessionSearchInService).toHaveBeenCalledTimes(1))
  expect(updateSessionSearchInService.mock.calls[0]?.[0]).toMatchObject({
    settings: { contentEnabled: true, historyDays: 30 },
    databasePath: join(harness.root, 'ai-vault', 'session-search.sqlite')
  })
})

it('forwards only a real settings change to the child', async () => {
  const { applySessionSearchSettingsChange, installChildSessionSearchService } =
    await import('./session-search-enablement')
  installed = installChildSessionSearchService({
    dataRoot: harness.root,
    getSettings: () => ({ aiVaultSearch: { contentEnabled: false, historyDays: null } })
  })
  await vi.waitFor(() => expect(updateSessionSearchInService).toHaveBeenCalledTimes(1))

  applySessionSearchSettingsChange(
    { aiVaultSearch: { contentEnabled: false, historyDays: null } },
    { aiVaultSearch: { contentEnabled: false, historyDays: null } }
  )
  expect(updateSessionSearchInService).toHaveBeenCalledTimes(1)

  applySessionSearchSettingsChange(
    { aiVaultSearch: { contentEnabled: false, historyDays: null } },
    { aiVaultSearch: { contentEnabled: true, historyDays: null } }
  )
  await vi.waitFor(() => expect(updateSessionSearchInService).toHaveBeenCalledTimes(2))
})

it('does not discover roots or arm a timer during registration', async () => {
  vi.useFakeTimers()
  const { installChildSessionSearchService } = await import('./session-search-enablement')
  installed = installChildSessionSearchService({
    dataRoot: harness.root,
    getSettings: () => ({ aiVaultSearch: { contentEnabled: false, historyDays: null } })
  })
  expect(updateSessionSearchInService).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(600_000)
  expect(localAiVaultScanRoots).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
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
  expect(await sessionSearchServiceStatus({}, 'relay')).toMatchObject({
    enabled: true,
    contentEnabled: false
  })
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

// The behavioural tests above prove the installers register; these prove each
// host's boot path reaches one, which no unit of either module can show.
it.each([
  [
    'desktop and headless serve',
    'src/main/startup/main-process-runtime-service.ts',
    'installChildSessionSearchService'
  ],
  ['orcad', 'src/main/orcad/orcad-session-search.ts', 'installInProcessSessionSearchService'],
  [
    'the relay daemon',
    'src/relay/relay-runtime-services.ts',
    'installInProcessSessionSearchService'
  ]
])('boots %s with a registered session search service', (_host, file, installer) => {
  const source = readFileSync(join(ROOT, file), 'utf8')
  expect(source).toContain(installer)
  expect(source).toMatch(new RegExp(`${installer}\\(\\{`))
})

it('disables immediately without root discovery', async () => {
  const { installChildSessionSearchService, applySessionSearchSettingsChange } =
    await import('./session-search-enablement')
  let settings = { aiVaultSearch: { contentEnabled: true, historyDays: null } }
  installed = installChildSessionSearchService({
    dataRoot: harness.root,
    getSettings: () => settings
  })
  updateSessionSearchInService.mockClear()
  const before = settings
  settings = { aiVaultSearch: { contentEnabled: false, historyDays: null } }
  applySessionSearchSettingsChange(before, settings)
  expect(updateSessionSearchInService).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ settings: settings.aiVaultSearch })
  )
  expect(localAiVaultScanRoots).not.toHaveBeenCalled()
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
it('re-applies consent on an in-process host without reinstalling the service', async () => {
  installed = installInProcessSessionSearchService({
    dataRoot: harness.root,
    roots: harness.roots,
    settings: { enabled: false, historyDays: null }
  })
  expect(await searchSessionService({ query: 'ledger' }, 'relay')).toEqual({
    kind: 'unavailable',
    reason: 'disabled'
  })

  installed?.apply?.({ enabled: true, historyDays: null })
  expect(await searchSessionService({ query: 'ledger' }, 'relay')).not.toMatchObject({
    kind: 'unavailable',
    reason: 'disabled'
  })

  installed?.apply?.({ enabled: false, historyDays: null })
  expect(await searchSessionService({ query: 'ledger' }, 'relay')).toEqual({
    kind: 'unavailable',
    reason: 'disabled'
  })
})

// orcad reaches the index through the deps hook the runtime RPC calls; the wiring is
// what no unit of either module can show.
it('wires orcad consent from the runtime hook to the installed service', () => {
  const source = readFileSync(join(ROOT, 'src/main/orcad/orcad-entry.ts'), 'utf8')
  expect(source).toContain('applySessionSearchSettings:')
  expect(source).toContain('sessionSearch?.apply(next)')
})
