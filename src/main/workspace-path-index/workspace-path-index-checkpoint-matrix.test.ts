import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION,
  workspacePathCatalogFoldCacheKey
} from '../../shared/workspace-path-catalog'
import {
  WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES,
  WORKSPACE_PATH_INDEX_HOST_MEMORY_BUDGET_BYTES,
  WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
} from '../../shared/__fixtures__/workspace-path-memory-measurement'
import type { WorkspacePathSearchFenceIdentity } from '../../shared/workspace-path-search-contract'
import type { WorkspacePathSearchInstrumentationEvent } from '../../shared/workspace-path-search-instrumentation'
import { WORKSPACE_PATH_PROVISIONAL_PAGE_BUDGET } from '../../shared/workspace-path-provisional-page-budget'
import { WorkspacePathIndexAdmission } from './workspace-path-index-admission'
import {
  createBenchmarkBuildCallback,
  type BenchmarkBuildObservations
} from './workspace-path-index-benchmark-build'
import {
  buildWorkspacePathIndexWorkerEntry,
  createPathIndexBenchmarkTemporaryDirectory,
  getBenchmarkQueryText,
  removePathIndexBenchmarkTemporaryDirectory,
  WORKSPACE_PATH_INDEX_BENCHMARK_SHAPES,
  WORKSPACE_PATH_INDEX_BENCHMARK_SIZES,
  type WorkspacePathCatalogShape
} from './workspace-path-index-benchmark-fixture'
import { WorkspacePathIndexService } from './workspace-path-index-service'
import { WorkspacePathIndexWorkerClient } from './workspace-path-index-worker-client'
import {
  WORKSPACE_PATH_CATALOG_CHECKPOINT_HOST_DISK_BUDGET_BYTES,
  WORKSPACE_PATH_CATALOG_CHECKPOINT_ROOT_DISK_BUDGET_BYTES,
  measureWorkspacePathCatalogCheckpointRootBytes,
  workspacePathCatalogCheckpointDirectory
} from './workspace-path-catalog-checkpoint-store'
import { workspacePathCatalogResidentCheckpointEncodeEnabled } from './workspace-path-catalog-checkpoint-policy'
import { directorySizeBytes } from './workspace-path-catalog-spill-runs-disk-budget'
import { workspacePathCatalogCheckpointIdentityHash } from './workspace-path-catalog-checkpoint-manifest'

const RUN_MATRIX = process.env.ORCA_RUN_PATH_INDEX_CHECKPOINT === '1'
// The resident re-encode is opt-in, so a default run reports it skipped and an opt-in run reports the
// encode cost the default avoids; the two campaign files are kept apart rather than overwritten.
const RESIDENT_ENCODE_ENABLED = workspacePathCatalogResidentCheckpointEncodeEnabled()
const REPORT_PATH = join(
  process.cwd(),
  'docs',
  'perf',
  RESIDENT_ENCODE_ENABLED
    ? 'workspace-path-index-checkpoint-phase7-bounded-page-resident-optin.json'
    : 'workspace-path-index-checkpoint-phase7-bounded-page.json'
)
const MAX_SIZE = Number(process.env.ORCA_PATH_INDEX_CHECKPOINT_MAX_SIZE ?? 1_000_000)
const SIZES = process.env.ORCA_PATH_INDEX_CHECKPOINT_SIZES
  ? process.env.ORCA_PATH_INDEX_CHECKPOINT_SIZES.split(',')
      .map((value) => Number(value.trim()))
      .filter((size) => Number.isSafeInteger(size) && size > 0)
  : WORKSPACE_PATH_INDEX_BENCHMARK_SIZES.filter((size) => size <= MAX_SIZE)
const SHAPES = process.env.ORCA_PATH_INDEX_CHECKPOINT_SHAPE
  ? WORKSPACE_PATH_INDEX_BENCHMARK_SHAPES.filter(
      (shape) => shape === process.env.ORCA_PATH_INDEX_CHECKPOINT_SHAPE
    )
  : WORKSPACE_PATH_INDEX_BENCHMARK_SHAPES
const RESTORE_REPETITIONS = 5
const WRITE_REPETITIONS = 3
const ROW_BUDGET_BYTES = WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
const HOST_BUDGET_BYTES = WORKSPACE_PATH_INDEX_HOST_MEMORY_BUDGET_BYTES
const PEAK_BYTES = WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES
const LISTING_POLICY_VERSION = 'quick-open-scope-v1'

type Spread = {
  label: string
  sampleCount: number
  p50Milliseconds: number
  p95Milliseconds: number
  maxMilliseconds: number
}

describe.skipIf(!RUN_MATRIX)('workspace path index checkpoint matrix', () => {
  it(
    'measures checkpoint write, restore, provisional latency, and reconciliation',
    async () => {
      const temporaryDirectory = await createPathIndexBenchmarkTemporaryDirectory()
      const workerPath = await buildWorkspacePathIndexWorkerEntry(temporaryDirectory)
      const cells: Record<string, unknown>[] = []
      try {
        for (const shape of SHAPES) {
          for (const size of SIZES) {
            cells.push(
              await measureCell({
                workerPath,
                temporaryDirectory,
                shape,
                size
              })
            )
            await mkdir(dirname(REPORT_PATH), { recursive: true })
            await writeFile(REPORT_PATH, `${JSON.stringify(createReport(cells), null, 2)}\n`)
          }
        }
      } finally {
        await removePathIndexBenchmarkTemporaryDirectory(temporaryDirectory)
      }
      expect(cells.length).toBeGreaterThan(0)
    },
    6 * 60 * 60 * 1000
  )
})

function createReport(cells: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    campaign: RESIDENT_ENCODE_ENABLED
      ? 'workspace-path-index-checkpoint-phase7-bounded-page-resident-optin'
      : 'workspace-path-index-checkpoint-phase7-bounded-page',
    metadata: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      fixtureIdsOnly: true,
      queryTextIncluded: false,
      restoreRepetitions: RESTORE_REPETITIONS,
      writeRepetitions: WRITE_REPETITIONS,
      provisionalLatencyTargetMilliseconds: 200,
      provisionalPageBudget: WORKSPACE_PATH_PROVISIONAL_PAGE_BUDGET,
      residentEncodeEnabled: RESIDENT_ENCODE_ENABLED,
      checkpointRootDiskBudgetBytes: WORKSPACE_PATH_CATALOG_CHECKPOINT_ROOT_DISK_BUDGET_BYTES,
      checkpointHostDiskBudgetBytes: WORKSPACE_PATH_CATALOG_CHECKPOINT_HOST_DISK_BUDGET_BYTES,
      rootBudgetBytes: ROW_BUDGET_BYTES,
      hostBudgetBytes: HOST_BUDGET_BYTES,
      buildPeakReservationBytes: PEAK_BYTES,
      foldVersion: workspacePathCatalogFoldCacheKey(),
      scopeRuleVersion: WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION,
      baseline: 'workspace-path-index-checkpoint-phase7.json',
      rawSampleClock: 'host-monotonic-performance-now'
    },
    cells
  }
}

async function measureCell(args: {
  workerPath: string
  temporaryDirectory: string
  shape: WorkspacePathCatalogShape
  size: number
}): Promise<Record<string, unknown>> {
  const cellDirectory = join(args.temporaryDirectory, `${args.shape}-${args.size}`)
  const spillDirectory = join(cellDirectory, 'spill')
  const checkpointDirectory = workspacePathCatalogCheckpointDirectory(
    join(cellDirectory, 'checkpoints'),
    workspacePathCatalogCheckpointIdentityHash(`${args.shape}:${args.size}`)
  )
  const cellArgs = {
    workerPath: args.workerPath,
    spillDirectory,
    checkpointDirectory,
    shape: args.shape,
    size: args.size
  }

  // Cold build on the same session, budgets, and machine as the restore it is compared against.
  const cold = await createReadyService(cellArgs)
  const storageMode = cold.storage.mode
  const spillFileBytes = cold.storage.spillFileBytes
  const ownershipKey = cold.ownershipKey
  const generationId = cold.generationId
  if (!ownershipKey || !generationId) {
    throw new Error('Cold build published no generation')
  }
  const writeMilliseconds: number[] = []
  const writerMilliseconds: number[] = []
  const payloadBytes: number[] = []
  const writeOutcomes: string[] = []
  let reusedSpillFile = false
  for (let attempt = 0; attempt < WRITE_REPETITIONS; attempt += 1) {
    const writeStartedAt = performance.now()
    const written = await cold.worker.writeCheckpoint({
      key: ownershipKey,
      generationId,
      checkpointDirectory,
      maxBytes: ROW_BUDGET_BYTES
    })
    // A refusal is a policy outcome, not a failure: under the default policy a resident root is not
    // re-encoded, and this cell records the cheap round trip that replaces the encode.
    writeMilliseconds.push(performance.now() - writeStartedAt)
    writeOutcomes.push(
      written.status === 'written'
        ? `written:${written.reusedSpillFile ? 'link' : 'encode'}`
        : written.status === 'absent'
          ? `absent:${written.reason}`
          : 'restored'
    )
    if (written.status === 'written') {
      payloadBytes.push(written.payloadBytes)
      // Writer-only duration: the previous campaign recorded this number, and the round trip above
      // additionally pays the base-plus-delta compaction the policy gate now skips.
      writerMilliseconds.push(written.writeMilliseconds)
      reusedSpillFile = written.reusedSpillFile
    }
  }
  const checkpointPayloadBytes = payloadBytes.at(-1) ?? 0
  const checkpointRootBytes = await measureWorkspacePathCatalogCheckpointRootBytes(
    dirname(checkpointDirectory)
  )
  const spillRootBytes = await directorySizeBytes(spillDirectory).catch(() => 0)
  const checkpointWritten = writeOutcomes.some((outcome) => outcome.startsWith('written'))
  await cold.service.dispose()

  // Pure load: one fresh worker per repetition, exactly what a restart pays before any query.
  const loadMilliseconds: number[] = []
  const workerLoadMilliseconds: number[] = []
  const directoryValidationMilliseconds: number[] = []
  if (checkpointWritten) {
    for (let attempt = 0; attempt < RESTORE_REPETITIONS; attempt += 1) {
      const worker = createWorker(args.workerPath, spillDirectory)
      try {
        const startedAt = performance.now()
        const restored = await worker.restoreCheckpoint({
          key: ownershipKey,
          checkpointDirectory
        })
        loadMilliseconds.push(performance.now() - startedAt)
        if (restored.status === 'absent') {
          throw new Error(`Checkpoint restore failed: ${restored.reason}`)
        }
        if (restored.status !== 'restored') {
          throw new Error('Checkpoint restore wrote instead of restoring')
        }
        workerLoadMilliseconds.push(restored.loadMilliseconds)
        directoryValidationMilliseconds.push(restored.directoryValidationMilliseconds)
      } finally {
        worker.dispose()
      }
    }
  }

  // First provisional answer after a restart: the number the 200 ms target is about.
  const provisionalMilliseconds: number[] = []
  const provisionalQueries: number[] = []
  const provisionalCoverage: string[] = []
  const provisionalSpillBlocksRead: number[] = []
  const restoreStatuses: string[] = []
  for (let attempt = 0; checkpointWritten && attempt < RESTORE_REPETITIONS; attempt += 1) {
    const harness = createService(cellArgs)
    try {
      const direct = await harness.worker.restoreCheckpoint({
        key: ownershipKey,
        checkpointDirectory
      })
      restoreStatuses.push(
        direct.status === 'restored'
          ? `restored:${direct.publishedScope}:${direct.pathCount}`
          : direct.status === 'absent'
            ? `absent:${direct.reason}`
            : 'written'
      )
      const startedAt = performance.now()
      const result = await harness.service.search(searchArgsFor(harness))
      provisionalMilliseconds.push(performance.now() - startedAt)
      if (!result.ready || result.response.state.freshness !== 'provisional') {
        throw new Error(
          `Expected a provisional answer, received ${
            result.ready ? result.response.state.freshness : `not-ready:${result.reason}`
          }; direct restore ${restoreStatuses.at(-1)}`
        )
      }
      if (result.response.state.countProvenance === 'exact-snapshot') {
        throw new Error('A restored checkpoint must never answer with an exact snapshot count')
      }
      if (result.response.count.value !== null) {
        throw new Error('A bounded provisional page must never claim a total count')
      }
      provisionalQueries.push(result.response.count.value ?? -1)
      provisionalCoverage.push(
        `${result.response.state.coverage}:${String(
          result.response.state.searchComplete
        )}:${String(result.response.degradationReason)}`
      )
      provisionalSpillBlocksRead.push(lastSpillBlocksRead(harness.events))
    } finally {
      await harness.service.dispose()
    }
  }

  // Reconciliation to ready is a full rebuild; measured once, because it is the cost of truth.
  const reconciling = createService(cellArgs)
  let reconcileToReadyMilliseconds: number | null = null
  try {
    if (checkpointWritten) {
      const startedAt = performance.now()
      const first = await reconciling.service.search(searchArgsFor(reconciling))
      if (!first.ready || first.response.state.freshness !== 'provisional') {
        throw new Error('Expected the first post-restart search to be provisional')
      }
      // Observe the rebuild through its own build observations: polling with search would issue a
      // multi-second spilled scan every tick and starve the very build being timed.
      for (let attempt = 0; attempt < 28_800; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (reconciling.observations.allScopesReadyAt !== null) {
          reconcileToReadyMilliseconds = performance.now() - startedAt
          break
        }
        if (reconciling.observations.error) {
          throw new Error(`Reconciliation failed: ${reconciling.observations.error}`)
        }
      }
      if (reconcileToReadyMilliseconds === null) {
        throw new Error('Reconciliation never promoted the root to ready')
      }
      await sleep(150)
      const promoted = await reconciling.service.search(searchArgsFor(reconciling))
      if (!promoted.ready || promoted.response.state.freshness !== 'no-known-gap') {
        throw new Error('Reconciliation did not promote the root to a fresh ready state')
      }
    }
  } finally {
    await reconciling.service.dispose()
  }

  return {
    fixtureId: `${args.shape}:${args.size}`,
    shape: args.shape,
    size: args.size,
    storageMode,
    spillFileBytes,
    coldBuild: {
      allScopesReadyMilliseconds: cold.buildMilliseconds,
      firstScopeReadyMilliseconds: cold.firstScopeMilliseconds
    },
    checkpoint: {
      payloadBytes: checkpointPayloadBytes,
      reusedSpillFile,
      writeOutcomes,
      write: spread('checkpoint-write', writeMilliseconds),
      writerOnly: spread('checkpoint-writer-only', writerMilliseconds),
      load: spread('checkpoint-load', loadMilliseconds),
      workerLoad: spread('checkpoint-worker-load', workerLoadMilliseconds),
      directoryValidation: spread(
        'checkpoint-directory-validation',
        directoryValidationMilliseconds
      ),
      provisionalFirstPage:
        provisionalMilliseconds.length > 0
          ? spread('checkpoint-provisional', provisionalMilliseconds)
          : null,
      provisionalCoverage,
      provisionalSpillBlocksRead,
      reconcileToReadyMilliseconds,
      provisionalCounts: provisionalQueries,
      restoreStatuses,
      diskBudget: {
        checkpointRootBytes,
        spillRootBytes,
        // Apparent bytes: a hardlinked checkpoint shares the spill inode and adds no real storage.
        apparentSharedBytes: checkpointRootBytes + spillRootBytes,
        perRootCapBytes: WORKSPACE_PATH_CATALOG_CHECKPOINT_ROOT_DISK_BUDGET_BYTES,
        hostCapBytes: WORKSPACE_PATH_CATALOG_CHECKPOINT_HOST_DISK_BUDGET_BYTES
      }
    },
    rawSamples: {
      writeMilliseconds,
      writerMilliseconds,
      loadMilliseconds,
      workerLoadMilliseconds,
      provisionalMilliseconds
    }
  }
}

function spread(label: string, samples: readonly number[]): Spread {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (quantile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0
  return {
    label,
    sampleCount: sorted.length,
    p50Milliseconds: at(0.5),
    p95Milliseconds: at(0.95),
    maxMilliseconds: sorted.at(-1) ?? 0
  }
}

function createWorker(
  workerPath: string,
  spillDirectory: string,
  events: WorkspacePathSearchInstrumentationEvent[] = []
): WorkspacePathIndexWorkerClient {
  return new WorkspacePathIndexWorkerClient({
    workerFactory: () => new Worker(workerPath),
    spillDirectory,
    onInstrumentation: (event) => events.push(event)
  })
}

/** How many spill blocks the provisional answer actually decoded; the bounded-page budget ceiling. */
function lastSpillBlocksRead(events: readonly WorkspacePathSearchInstrumentationEvent[]): number {
  let blocks = -1
  for (const event of events) {
    if (event.kind === 'query-metrics' && event.record.spillBlocksRead !== undefined) {
      blocks = event.record.spillBlocksRead
    }
  }
  return blocks
}

function ownerFor(shape: string, size: number) {
  return {
    executionHost: {
      provider: 'local' as const,
      incarnationId: 'checkpoint-matrix'
    },
    authorizedCanonicalRoot: `/checkpoint-matrix/${shape}/${size}`
  }
}

type Harness = {
  service: WorkspacePathIndexService
  worker: WorkspacePathIndexWorkerClient
  shape: WorkspacePathCatalogShape
  size: number
  owner: ReturnType<typeof ownerFor>
  identity: WorkspacePathSearchFenceIdentity
  observations: BenchmarkBuildObservations
  storage: { mode: 'resident' | 'spilled' | 'unknown'; spillFileBytes: number }
  events: WorkspacePathSearchInstrumentationEvent[]
  correlationId: string
}

function createService(args: {
  workerPath: string
  spillDirectory: string
  checkpointDirectory: string
  shape: WorkspacePathCatalogShape
  size: number
}): Harness {
  const events: WorkspacePathSearchInstrumentationEvent[] = []
  const worker = createWorker(args.workerPath, args.spillDirectory, events)
  const owner = ownerFor(args.shape, args.size)
  const storage: Harness['storage'] = { mode: 'unknown', spillFileBytes: 0 }
  const observations: BenchmarkBuildObservations = {
    startedAt: 0,
    finishedAt: 0,
    firstScopeReadyAt: null,
    allScopesReadyAt: null,
    cpuUserMicroseconds: 0,
    cpuSystemMicroseconds: 0,
    outcome: null,
    degradationReason: null,
    error: null,
    memorySamples: [],
    workerMemorySamples: [],
    startWorkerMemorySampling: () => undefined,
    stopWorkerMemorySampling: () => undefined,
    resolveComplete: null
  }
  const service = createServiceInstance(storage, {
    worker,
    observations,
    args
  })
  return {
    service,
    worker,
    shape: args.shape,
    size: args.size,
    owner,
    identity: {
      query: getBenchmarkQueryText(args.shape, 'broad-one-character'),
      consumer: { consumerId: `checkpoint-matrix-${args.shape}`, sequence: 1 },
      owner,
      generationId: null,
      mode: 'name-filter',
      scope: {
        pathSet: 'all',
        includeDotfiles: true,
        includeIgnoredFiles: true,
        excludePathSegments: []
      },
      pageBudget: { maxPaths: 5_000, maxSerializedBytes: 4 * 1024 * 1024 }
    },
    observations,
    storage,
    events,
    correlationId: `checkpoint-matrix-${args.shape}-${args.size}`
  }
}

/** Takes the mutable storage record directly so the callbacks never read a half-built harness. */
function createServiceInstance(
  storage: Harness['storage'],
  context: {
    worker: WorkspacePathIndexWorkerClient
    observations: BenchmarkBuildObservations
    args: {
      checkpointDirectory: string
      shape: WorkspacePathCatalogShape
      size: number
    }
  }
): WorkspacePathIndexService {
  const { worker, observations, args } = context
  return new WorkspacePathIndexService({
    authorize: async (candidate) => candidate.authorizedCanonicalRoot,
    build: async (request) => {
      const built = await createBenchmarkBuildCallback({
        worker,
        size: args.size,
        shape: args.shape,
        memoryBudgetBytes: ROW_BUDGET_BYTES,
        observations
      })(request)
      if (built.storageMode) {
        storage.mode = built.storageMode === 'disk-spilled' ? 'spilled' : 'resident'
      }
      storage.spillFileBytes = built.spillFileBytes ?? storage.spillFileBytes
      return built
    },
    query: (request) => worker.query(request.key, request.identity, request.correlationId),
    cancelQuery: (consumerKey) => worker.cancel(consumerKey),
    applyDelta: (request) => worker.applyDelta(request),
    admission: new WorkspacePathIndexAdmission(ROW_BUDGET_BYTES, HOST_BUDGET_BYTES),
    peakBuildReservationBytes: PEAK_BYTES,
    maxGenerationBytes: ROW_BUDGET_BYTES,
    spillResidentCatalog: (key, generationId) => worker.spillResidentCatalog(key, generationId),
    restoreCheckpoint: async ({ entryKey }) => {
      const restored = await worker.restoreCheckpoint({
        key: entryKey,
        checkpointDirectory: args.checkpointDirectory
      })
      return restored.status === 'restored'
        ? {
            generationId: restored.generationId,
            publishedScope: restored.publishedScope,
            retainedBytes: restored.retainedBytes,
            loadMilliseconds: restored.loadMilliseconds
          }
        : null
    },
    writeCheckpoint: () => undefined,
    disposeGeneration: (key) => {
      void worker.drop(key).catch(() => undefined)
    },
    shutdownWorker: () => worker.dispose()
  })
}

function searchArgsFor(harness: Harness): {
  identity: WorkspacePathSearchFenceIdentity
  listingPolicyVersion: string
  foldVersion: string
  buildReservationBytes: number
  correlationId: string
} {
  return {
    identity: harness.identity,
    listingPolicyVersion: LISTING_POLICY_VERSION,
    foldVersion: workspacePathCatalogFoldCacheKey(),
    buildReservationBytes: ROW_BUDGET_BYTES,
    correlationId: harness.correlationId
  }
}

async function createReadyService(args: {
  workerPath: string
  spillDirectory: string
  checkpointDirectory: string
  shape: WorkspacePathCatalogShape
  size: number
}): Promise<
  Harness & {
    buildMilliseconds: number
    firstScopeMilliseconds: number
    ownershipKey: string | null
    generationId: string | undefined
  }
> {
  const harness = createService(args)
  const ensureOnce = (): ReturnType<WorkspacePathIndexService['ensure']> =>
    harness.service.ensure({
      owner: harness.owner,
      listingPolicyVersion: LISTING_POLICY_VERSION,
      foldVersion: workspacePathCatalogFoldCacheKey(),
      buildReservationBytes: ROW_BUDGET_BYTES,
      firstScope: 'included',
      activeWorkspace: true,
      correlationId: harness.correlationId
    })
  let ensured = await ensureOnce()
  for (let attempt = 0; !ensured.ready && attempt < 7_200; attempt += 1) {
    await sleep(250)
    ensured = await ensureOnce()
  }
  if (!ensured.ready) {
    throw new Error(`Cold build never became ready for ${args.shape}:${args.size}`)
  }
  // A first-scope publication is already "ready"; the checkpoint unit is the complete snapshot.
  for (let attempt = 0; harness.observations.outcome === null && attempt < 7_200; attempt += 1) {
    if (harness.observations.error) {
      throw new Error(`Cold build failed: ${harness.observations.error}`)
    }
    await sleep(100)
  }
  if (harness.observations.outcome === null) {
    throw new Error(`Cold build never published both scopes for ${args.shape}:${args.size}`)
  }
  await sleep(100)
  // Re-read after completion: the final generation carries the second scope, unlike the
  // first-scope publication that made the entry "ready" moments earlier.
  const completed = await ensureOnce()
  if (!completed.ready) {
    throw new Error(`Completed build did not stay ready for ${args.shape}:${args.size}`)
  }
  const observations = harness.observations
  return {
    ...harness,
    buildMilliseconds:
      observations.allScopesReadyAt === null
        ? 0
        : observations.allScopesReadyAt - observations.startedAt,
    firstScopeMilliseconds:
      observations.firstScopeReadyAt === null
        ? 0
        : observations.firstScopeReadyAt - observations.startedAt,
    ownershipKey: completed.key,
    generationId: completed.generationId
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
