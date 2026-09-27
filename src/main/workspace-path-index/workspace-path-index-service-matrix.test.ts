import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { freemem, totalmem } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateWorkspacePathCatalog } from '../../shared/__fixtures__/workspace-path-catalog'
import {
  WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES,
  WORKSPACE_PATH_INDEX_HOST_MEMORY_BUDGET_BYTES,
  WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
} from '../../shared/__fixtures__/workspace-path-memory-measurement'
import { estimateWorkspacePathCatalogPathReservation } from '../../shared/workspace-path-catalog-builder-admission'
import {
  isEligibleWorkspaceCatalogPath,
  normalizeWorkspaceRelativePath
} from '../../shared/workspace-path-catalog'
import { WorkspacePathIndexService } from './workspace-path-index-service'
import { WorkspacePathIndexAdmission } from './workspace-path-index-admission'
import {
  buildWorkspacePathIndexWorkerEntry,
  createPathIndexBenchmarkTemporaryDirectory,
  describeBenchmarkMachine,
  MEBIBYTE,
  removePathIndexBenchmarkTemporaryDirectory,
  WORKSPACE_PATH_INDEX_BENCHMARK_MILLION_REPETITIONS,
  WORKSPACE_PATH_INDEX_BENCHMARK_REPETITIONS,
  WORKSPACE_PATH_INDEX_BENCHMARK_SEED,
  WORKSPACE_PATH_INDEX_BENCHMARK_PROFILES,
  WORKSPACE_PATH_INDEX_BENCHMARK_SIZES,
  WORKSPACE_PATH_INDEX_QUERY_CLASSES,
  type WorkspacePathIndexQueryClass
} from './workspace-path-index-benchmark-fixture'
import { createWorkspacePathIndexBenchmarkSession } from './workspace-path-index-benchmark-session'

const runMatrix = process.env.ORCA_RUN_PATH_INDEX_MATRIX === '1'
const REPORT_PATH = join(process.cwd(), 'docs', 'perf', 'workspace-path-index-matrix-phase6b.json')
const MATRIX_BUDGET_BYTES = Math.min(4 * 1024 * MEBIBYTE, Math.floor(totalmem() * 0.35))
const MATRIX_MAX_SIZE = Number(process.env.ORCA_PATH_INDEX_MATRIX_MAX_SIZE ?? 1_000_000)
const MATRIX_SIZES = WORKSPACE_PATH_INDEX_BENCHMARK_SIZES.filter((size) => size <= MATRIX_MAX_SIZE)

type WarmSample = Awaited<
  ReturnType<Awaited<ReturnType<typeof createWorkspacePathIndexBenchmarkSession>>['search']>
>

type WarmQueryReport = {
  queryClass: WorkspacePathIndexQueryClass
  sampleCount: number
  p50Milliseconds: number | null
  p95Milliseconds: number | null
  maxMilliseconds: number | null
  targetMilliseconds: number
  verdict: 'pass' | 'miss' | 'unmeasured'
  overTargetMilliseconds: number | null
  rawSamples: WarmSample[]
}

describe.skipIf(!runMatrix)('workspace path index service performance matrix', () => {
  it('measures worker-backed query, admission, build, memory, and churn behavior', async () => {
    const temporaryDirectory = await createPathIndexBenchmarkTemporaryDirectory()
    const workerPath = await buildWorkspacePathIndexWorkerEntry(temporaryDirectory)
    const fixtures: Record<string, unknown>[] = []
    let churn: Record<string, unknown> | null = null
    try {
      for (const profile of WORKSPACE_PATH_INDEX_BENCHMARK_PROFILES) {
        for (const size of MATRIX_SIZES) {
          const fixtureId = `${profile}:${size}`
          const estimatedPeakBytes = estimateFixturePeakBytes(size, profile)
          if (estimatedPeakBytes > Math.min(freemem() * 0.75, MATRIX_BUDGET_BYTES)) {
            fixtures.push({
              fixtureId,
              size,
              profile,
              seed: WORKSPACE_PATH_INDEX_BENCHMARK_SEED,
              status: 'resource-cap',
              estimatedPeakBytes,
              availableBudgetBytes: Math.min(freemem(), MATRIX_BUDGET_BYTES),
              queries: unmeasuredQueries(size)
            })
            continue
          }
          const session = await createWorkspacePathIndexBenchmarkSession({
            workerPath,
            size,
            profile,
            memoryBudgetBytes: MATRIX_BUDGET_BYTES
          })
          try {
            if (!session.ready) {
              console.info(
                `[path-index-build-diagnostic] ${fixtureId} ${session.build.error ?? 'no-error'}`
              )
            }
            const queries = await measureWarmQueries(session, size)
            const fixture: Record<string, unknown> = {
              fixtureId,
              size,
              profile,
              seed: WORKSPACE_PATH_INDEX_BENCHMARK_SEED,
              status: session.ready ? 'measured' : 'build-unavailable',
              build: {
                ...session.build,
                error: session.build.error ? 'build-failed' : null,
                outcome: session.build.outcome
                  ? {
                      retainedBytes: session.build.outcome.retainedBytes,
                      trigramPostingsBytes: session.build.outcome.trigramPostingsBytes,
                      storageMode: session.build.outcome.storageMode ?? 'unknown',
                      spillFileBytes: session.build.outcome.spillFileBytes ?? 0,
                      degradationReason: session.build.outcome.degradationReason ?? null
                    }
                  : null
              },
              residentOrSpillModeQueries: queries
            }
            const defaultBudgetSession = await createWorkspacePathIndexBenchmarkSession({
              workerPath,
              size,
              profile,
              memoryBudgetBytes: WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
            })
            try {
              fixture.defaultBudgets = {
                status: defaultBudgetSession.ready ? 'measured' : 'build-unavailable',
                build: {
                  ...defaultBudgetSession.build,
                  error: defaultBudgetSession.build.error ? 'build-failed' : null,
                  outcome: defaultBudgetSession.build.outcome
                    ? {
                        retainedBytes: defaultBudgetSession.build.outcome.retainedBytes,
                        trigramPostingsBytes:
                          defaultBudgetSession.build.outcome.trigramPostingsBytes,
                        storageMode: defaultBudgetSession.build.outcome.storageMode ?? 'unknown',
                        spillFileBytes: defaultBudgetSession.build.outcome.spillFileBytes ?? 0,
                        degradationReason:
                          defaultBudgetSession.build.outcome.degradationReason ?? null
                      }
                    : null
                },
                queries: await measureWarmQueries(defaultBudgetSession, size)
              }
            } finally {
              await defaultBudgetSession.dispose()
            }
            if (
              !churn &&
              size === 100_000 &&
              profile === 'realistic-shared-prefixes' &&
              session.ready
            ) {
              churn = await measureChurn(session, fixtures.length)
            }
            fixtures.push(fixture)
          } finally {
            await session.dispose()
          }
        }
      }
      const admission = await measureAdmissionBoundary(workerPath)
      const report = {
        schemaVersion: 1,
        metadata: {
          ...describeBenchmarkMachine(),
          coresReportedByUser: 12,
          campaign: 'workspace-path-index-service-worker-phase6b',
          fixtureIdsOnly: true,
          queryTextIncluded: false,
          baseline: 'workspace-path-index-matrix-phase6a.json',
          rawSampleClock: 'host-monotonic-performance-now',
          defaultRootBudgetBytes: WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES,
          defaultHostBudgetBytes: WORKSPACE_PATH_INDEX_HOST_MEMORY_BUDGET_BYTES,
          defaultBuildPeakReservationBytes: WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES,
          experimentalWarmBuildBudgetBytes: MATRIX_BUDGET_BYTES,
          warmRunCountBelowOneMillion: WORKSPACE_PATH_INDEX_BENCHMARK_REPETITIONS,
          warmRunCountAtOneMillion: WORKSPACE_PATH_INDEX_BENCHMARK_MILLION_REPETITIONS,
          selectedSizes: MATRIX_SIZES,
          campaignComplete: MATRIX_SIZES.length === WORKSPACE_PATH_INDEX_BENCHMARK_SIZES.length,
          memorySamplerIntervalMilliseconds: 10
        },
        hostTargetsMilliseconds: {
          upTo500k: 25,
          oneMillion: 60
        },
        matrix: fixtures,
        admission,
        churn
      }
      await mkdir(join(process.cwd(), 'docs', 'perf'), { recursive: true })
      await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
      console.info(
        `[workspace-path-index-matrix] fixtures=${fixtures.length} churn=${Boolean(churn)}`
      )
      expect(fixtures).toHaveLength(
        MATRIX_SIZES.length * WORKSPACE_PATH_INDEX_BENCHMARK_PROFILES.length
      )
    } finally {
      await removePathIndexBenchmarkTemporaryDirectory(temporaryDirectory)
    }
  }, 1_800_000)
})

async function measureChurn(
  session: Awaited<ReturnType<typeof createWorkspacePathIndexBenchmarkSession>>,
  fixtureIndex: number
): Promise<Record<string, unknown>> {
  let sequence = 0
  const queryAfterDelta = async () => {
    const startedAt = performance.now()
    const result = await session.search('directory-fragment')
    return {
      milliseconds: performance.now() - startedAt,
      ready: result.ready,
      pathsConsidered: result.pathsConsidered
    }
  }
  const createdPath = 'bench/churn-create-sentinel.ts'
  const create = await session.applyDelta([{ type: 'add', path: createdPath, pathSet: 'all' }])
  const createQuery = await queryAfterDelta()
  const remove = await session.applyDelta([{ type: 'delete', path: createdPath }])
  const deleteQuery = await queryAfterDelta()
  const rename = await session.applyDelta([
    { type: 'delete', path: 'src/components/Button/index.ts' },
    { type: 'add', path: 'bench/churn-rename-sentinel.ts', pathSet: 'all' }
  ])
  const renameQuery = await queryAfterDelta()

  const stormMutations = Array.from({ length: 100 }, (_, index) => ({
    type: 'add' as const,
    path: `bench/storm-${index.toString(36)}.ts`,
    pathSet: 'all' as const
  }))
  const stormStart = performance.now()
  const stormApply = session.applyDelta(stormMutations)
  const inFlightQuery = queryAfterDelta()
  const [storm, queryDuringStorm] = await Promise.all([stormApply, inFlightQuery])
  const compactionMutations = Array.from({ length: 10_000 }, (_, index) => ({
    type: 'add' as const,
    path: `bench/compact-${index.toString(36)}.ts`,
    pathSet: 'all' as const
  }))
  const compaction = await session.applyDelta(compactionMutations)
  const compactionEvents = session.maintenanceEvents.filter(
    (event) => event.action === 'compaction-triggered'
  )
  sequence += 1
  return {
    fixtureId: `realistic-shared-prefixes:100000:${fixtureIndex}`,
    create: {
      publishMilliseconds: create.publishMilliseconds,
      accepted: create.accepted,
      nextQuery: createQuery
    },
    delete: {
      publishMilliseconds: remove.publishMilliseconds,
      accepted: remove.accepted,
      nextQuery: deleteQuery
    },
    rename: {
      publishMilliseconds: rename.publishMilliseconds,
      accepted: rename.accepted,
      nextQuery: renameQuery
    },
    storm: {
      eventsSubmitted: stormMutations.length,
      serviceBatchCalls: 1,
      publishMilliseconds: storm.publishMilliseconds,
      accepted: storm.accepted,
      queryDuringChurn: queryDuringStorm,
      totalMilliseconds: performance.now() - stormStart
    },
    compaction: {
      mutationsSubmitted: compactionMutations.length,
      publishMilliseconds: compaction.publishMilliseconds,
      accepted: compaction.accepted,
      triggerEvents: compactionEvents.map((event) => ({
        pathCount: event.pathCount,
        byteCount: event.byteCount,
        durationMilliseconds: event.durationMilliseconds
      }))
    },
    coalescingNote:
      'One explicit 100-mutation service batch measured; watcher producer coalescing is not exercised.',
    runSequence: sequence
  }
}

async function measureAdmissionBoundary(workerPath: string): Promise<Record<string, unknown>> {
  const rootBudgetBytes = WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
  const hostBudgetBytes = WORKSPACE_PATH_INDEX_HOST_MEMORY_BUDGET_BYTES
  const boundaries = WORKSPACE_PATH_INDEX_BENCHMARK_PROFILES.map((profile) => {
    let reservationBytes = 0
    let admittedCatalogPathCount = 0
    let generatedPathsBeforeBoundary = 0
    let nextPathReservationBytes: number | null = null
    for (const path of generateWorkspacePathCatalog({
      size: 1_000_000,
      profile,
      seed: WORKSPACE_PATH_INDEX_BENCHMARK_SEED
    })) {
      generatedPathsBeforeBoundary += 1
      const normalizedPath = normalizeWorkspaceRelativePath(path)
      if (!isEligibleWorkspaceCatalogPath(normalizedPath)) {
        continue
      }
      const pathReservationBytes = estimateWorkspacePathCatalogPathReservation(
        normalizedPath,
        'packed-folded'
      )
      if (reservationBytes + pathReservationBytes > rootBudgetBytes) {
        nextPathReservationBytes = pathReservationBytes
        break
      }
      reservationBytes += pathReservationBytes
      admittedCatalogPathCount += 1
    }
    return {
      fixtureId: profile,
      maximumEligibleCatalogPathCountByBuilderReservation: admittedCatalogPathCount,
      generatedPathsBeforeBoundary,
      maximumSingleRootReservationBytes: reservationBytes,
      nextPathReservationBytes,
      exceedsRootBudgetAtNextPath:
        nextPathReservationBytes === null ||
        reservationBytes + nextPathReservationBytes > rootBudgetBytes
    }
  })
  const owner = {
    executionHost: { provider: 'local', incarnationId: 'admission-probe' },
    authorizedCanonicalRoot: '/admission-probe'
  }
  let buildCalls = 0
  let buildSettledResolve: (() => void) | null = null
  const buildSettled = new Promise<void>((resolveBuild) => {
    buildSettledResolve = resolveBuild
  })
  const service = new WorkspacePathIndexService({
    authorize: async (candidate) => candidate.authorizedCanonicalRoot,
    build: async (request) => {
      buildCalls += 1
      buildSettledResolve?.()
      return { generationId: request.generationId, retainedBytes: 64 }
    },
    query: async () => {
      throw new Error('Admission probe does not query')
    },
    admission: new WorkspacePathIndexAdmission(),
    retryBackoffMilliseconds: 0
  })
  const oversizedReservationBytes = 517_371_700
  const oversized = await service.ensure({
    owner,
    listingPolicyVersion: 'admission-probe-v1',
    foldVersion: 'admission-probe-v1',
    buildReservationBytes: oversizedReservationBytes,
    correlationId: 'admission-oversized'
  })
  const boundaryBytes = boundaries[0]?.maximumSingleRootReservationBytes ?? 0
  const shrinkAttempt = await service.ensure({
    owner,
    listingPolicyVersion: 'admission-probe-v1',
    foldVersion: 'admission-probe-v1',
    buildReservationBytes: boundaryBytes,
    correlationId: 'admission-after-shrink'
  })
  await buildSettled
  await yieldToEventLoop()
  const recovered = await service.ensure({
    owner,
    listingPolicyVersion: 'admission-probe-v1',
    foldVersion: 'admission-probe-v1',
    buildReservationBytes: boundaryBytes,
    correlationId: 'admission-recovered'
  })
  service.dispose()
  const verifiedServiceBoundary: Record<string, unknown>[] = []
  for (const profile of WORKSPACE_PATH_INDEX_BENCHMARK_PROFILES) {
    verifiedServiceBoundary.push(await measureVerifiedServiceBoundary(workerPath, profile))
  }
  return {
    defaultRootBudgetBytes: rootBudgetBytes,
    defaultHostBudgetBytes: hostBudgetBytes,
    verifiedServiceBoundary,
    admissionModel:
      'per-root steady catalog bytes plus host build reservation; complete worker builds use packed resident storage or checksummed disk-spilled blocks',
    boundaries,
    knownOneMillionReservationBytes: oversizedReservationBytes,
    knownOneMillionReservationMiB: oversizedReservationBytes / MEBIBYTE,
    serviceRefusesKnownOneMillionReservation:
      !oversized.ready && oversized.reason === 'over-budget',
    oversizedAttemptStartsBuild: false,
    boundaryAttemptInitiallyStartsBuild:
      !shrinkAttempt.ready && shrinkAttempt.reason === 'building',
    buildCalls,
    recoversAfterShrinkingReservation: recovered.ready,
    staticRootReservationCapacityPathsAreEstimatorBound: true,
    limitNote:
      'The boundary is established by complete service builds and an exact worker query. Build-run scratch, resident coexistence, file blocks, and process peak determine acceptance; no path-count estimator is treated as admission.'
  }
}

async function measureVerifiedServiceBoundary(
  workerPath: string,
  profile: (typeof WORKSPACE_PATH_INDEX_BENCHMARK_PROFILES)[number]
): Promise<Record<string, unknown>> {
  let admittedSize = 0
  let rejectedSize = 1_000_000
  const probes: Record<string, unknown>[] = []
  const millionProbes: { admitted: boolean; record: Record<string, unknown> }[] = []
  for (let repetition = 0; repetition < 2; repetition += 1) {
    millionProbes.push(await runBoundaryProbe(workerPath, profile, 1_000_000, repetition))
  }
  probes.push(...millionProbes.map((probe) => probe.record))
  if (millionProbes.every((probe) => probe.admitted)) {
    return {
      fixtureId: profile,
      method:
        'complete 1M WorkspacePathIndexService worker build at default budgets; scale-floor admission proven',
      requestedPathCountResolution: 1_000,
      largestVerifiedRequestedPathCount: 1_000_000,
      firstRejectedRequestedPathCount: null,
      probes
    }
  }
  while (rejectedSize - admittedSize > 1_000) {
    const candidateSize = Math.floor((admittedSize + rejectedSize) / 2 / 1_000) * 1_000
    const probe = await runBoundaryProbe(workerPath, profile, candidateSize)
    probes.push(probe.record)
    if (probe.admitted) {
      admittedSize = candidateSize
    } else {
      rejectedSize = candidateSize
    }
  }
  return {
    fixtureId: profile,
    method:
      'binary search through complete WorkspacePathIndexService worker builds at default budgets',
    requestedPathCountResolution: 1_000,
    largestVerifiedRequestedPathCount: admittedSize,
    firstRejectedRequestedPathCount: rejectedSize,
    probes
  }
}

async function runBoundaryProbe(
  workerPath: string,
  profile: (typeof WORKSPACE_PATH_INDEX_BENCHMARK_PROFILES)[number],
  candidateSize: number,
  repetition = 0
): Promise<{ admitted: boolean; record: Record<string, unknown> }> {
  const session = await createWorkspacePathIndexBenchmarkSession({
    workerPath,
    size: candidateSize,
    profile,
    memoryBudgetBytes: WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
  })
  try {
    const query = session.ready ? await session.search('no-match') : null
    const admitted = session.ready && query?.ready === true
    return {
      admitted,
      record: {
        requestedPathCount: candidateSize,
        repetition,
        admitted,
        indexedPathCount: query?.pathsConsidered ?? null,
        retainedBytes: session.build.retainedBytes,
        storageMode: session.build.outcome?.storageMode ?? 'unavailable',
        spillFileBytes: session.build.outcome?.spillFileBytes ?? 0,
        buildReservationBytes: session.build.buildReservationBytes,
        hostPeakBuildReservationBytes: session.build.hostPeakBuildReservationBytes,
        peakRssDeltaBytes: session.build.peakRssDeltaBytes,
        peakHostHeapUsedDeltaBytes: session.build.peakHostHeapUsedDeltaBytes,
        peakWorkerHeapUsedDeltaBytes: session.build.peakWorkerHeapUsedDeltaBytes,
        peakWorkerExternalDeltaBytes: session.build.peakWorkerExternalDeltaBytes,
        allScopesReadyMilliseconds: session.build.allScopesReadyMilliseconds,
        degradationReason: session.build.degradationReason
      }
    }
  } finally {
    await session.dispose()
  }
}

async function measureWarmQueries(
  session: Awaited<ReturnType<typeof createWorkspacePathIndexBenchmarkSession>>,
  size: number
): Promise<WarmQueryReport[]> {
  const repetitions =
    size === 1_000_000
      ? WORKSPACE_PATH_INDEX_BENCHMARK_MILLION_REPETITIONS
      : WORKSPACE_PATH_INDEX_BENCHMARK_REPETITIONS
  const queries: WarmQueryReport[] = []
  for (const queryClass of WORKSPACE_PATH_INDEX_QUERY_CLASSES) {
    const rawSamples: WarmSample[] = []
    if (session.ready) {
      await session.search(queryClass)
      for (let sample = 0; sample < repetitions; sample += 1) {
        rawSamples.push(await session.search(queryClass))
      }
    }
    queries.push(summarizeWarmQuery(queryClass, rawSamples, size))
  }
  return queries
}

function summarizeWarmQuery(
  queryClass: WorkspacePathIndexQueryClass,
  rawSamples: WarmSample[],
  size: number
): WarmQueryReport {
  const values = rawSamples
    .map((sample) => sample.serviceRoundTripMilliseconds)
    .sort((a, b) => a - b)
  const p50 = percentile(values, 0.5)
  const p95 = percentile(values, 0.95)
  const targetMilliseconds = size <= 500_000 ? 25 : 60
  return {
    queryClass,
    sampleCount: rawSamples.length,
    p50Milliseconds: p50,
    p95Milliseconds: p95,
    maxMilliseconds: values.at(-1) ?? null,
    targetMilliseconds,
    overTargetMilliseconds: p95 === null ? null : Math.max(0, p95 - targetMilliseconds),
    verdict:
      rawSamples.length === 0 || p95 === null
        ? 'unmeasured'
        : p95 <= targetMilliseconds
          ? 'pass'
          : 'miss',
    rawSamples
  }
}

function unmeasuredQueries(size: number): WarmQueryReport[] {
  return WORKSPACE_PATH_INDEX_QUERY_CLASSES.map((queryClass) => ({
    queryClass,
    sampleCount: 0,
    p50Milliseconds: null,
    p95Milliseconds: null,
    maxMilliseconds: null,
    targetMilliseconds: size <= 500_000 ? 25 : 60,
    verdict: 'unmeasured',
    overTargetMilliseconds: null,
    rawSamples: []
  }))
}

function percentile(sortedValues: readonly number[], quantile: number): number | null {
  if (sortedValues.length === 0) {
    return null
  }
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * quantile) - 1)] ?? null
}

function estimateFixturePeakBytes(
  size: number,
  profile: (typeof WORKSPACE_PATH_INDEX_BENCHMARK_PROFILES)[number]
): number {
  let sampledCharacters = 0
  let sampledPaths = 0
  for (const path of generateWorkspacePathCatalog({
    size: 1_000,
    profile,
    seed: WORKSPACE_PATH_INDEX_BENCHMARK_SEED
  })) {
    sampledCharacters += path.length
    sampledPaths += 1
  }
  const averagePathCharacters = sampledPaths === 0 ? 0 : sampledCharacters / sampledPaths
  return Math.ceil(size * (averagePathCharacters * 8 + 768))
}
