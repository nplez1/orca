import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { dirname, join } from 'node:path'
import { MessageChannel, Worker } from 'node:worker_threads'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchOwnerIdentity
} from '../../shared/workspace-path-search-contract'
import type {
  WorkspacePathSearchInstrumentationEvent,
  WorkspacePathSearchMaintenanceEvent,
  WorkspacePathSearchQueryMetrics,
  WorkspacePathSearchTimingStage
} from '../../shared/workspace-path-search-instrumentation'
import { WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES } from '../../shared/__fixtures__/workspace-path-memory-measurement'
import type { WorkspacePathCatalogProfile } from '../../shared/__fixtures__/workspace-path-catalog'
import { WorkspacePathIndexAdmission } from './workspace-path-index-admission'
import { WorkspacePathIndexService } from './workspace-path-index-service'
import { WorkspacePathIndexWorkerClient } from './workspace-path-index-worker-client'
import {
  createBenchmarkBuildCallback,
  type BenchmarkBuildObservations
} from './workspace-path-index-benchmark-build'
import { createWorkspacePathIndexBenchmarkBuildReport } from './workspace-path-index-benchmark-build-report'
import {
  getBenchmarkQueryText,
  isWorkerMemoryReading,
  WORKSPACE_PATH_INDEX_BENCHMARK_SEED,
  type WorkspacePathIndexBenchmarkSession,
  type WorkspacePathIndexQueryClass,
  type WorkerMemoryUsageSample
} from './workspace-path-index-benchmark-fixture'

export async function createWorkspacePathIndexBenchmarkSession(args: {
  workerPath: string
  size: number
  profile: WorkspacePathCatalogProfile
  memoryBudgetBytes: number
}): Promise<WorkspacePathIndexBenchmarkSession> {
  const owner: WorkspacePathSearchOwnerIdentity = {
    executionHost: { provider: 'local', incarnationId: 'path-index-matrix' },
    authorizedCanonicalRoot: '/path-index-matrix'
  }
  const metricsByCorrelation = new Map<string, WorkspacePathSearchQueryMetrics>()
  const timingsByCorrelation = new Map<
    string,
    Partial<Record<WorkspacePathSearchTimingStage, number>>
  >()
  const workerStageTimings: { stage: string; milliseconds: number }[] = []
  const maintenanceEvents: WorkspacePathSearchMaintenanceEvent[] = []
  const memoryChannel = new MessageChannel()
  const workerMemorySamples: WorkerMemoryUsageSample[] = []
  let workerMemorySequence = 0
  memoryChannel.port1.on('message', (value: unknown) => {
    if (isWorkerMemoryReading(value)) {
      workerMemorySequence += 1
      workerMemorySamples.push({ ...value, sampleSequence: workerMemorySequence })
    }
  })
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
    workerMemorySamples,
    startWorkerMemorySampling: () => memoryChannel.port1.postMessage({ type: 'start' }),
    stopWorkerMemorySampling: () => memoryChannel.port1.postMessage({ type: 'stop' }),
    resolveComplete: null
  }
  const buildComplete = new Promise<void>((resolveBuild) => {
    observations.resolveComplete = resolveBuild
  })
  let sequence = 0
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 })
  let spawnedWorker: Worker | null = null
  const worker = new WorkspacePathIndexWorkerClient({
    workerFactory: () => {
      spawnedWorker = new Worker(args.workerPath, {
        workerData: { memoryPort: memoryChannel.port2 },
        transferList: [memoryChannel.port2]
      })
      return spawnedWorker
    },
    onInstrumentation: recordEvent,
    spillDirectory: join(dirname(args.workerPath), 'spill-storage')
  })
  const service = new WorkspacePathIndexService({
    authorize: async (candidate) => candidate.authorizedCanonicalRoot,
    build: createBenchmarkBuildCallback({
      worker,
      size: args.size,
      profile: args.profile,
      memoryBudgetBytes: args.memoryBudgetBytes,
      observations
    }),
    query: (request) => worker.query(request.key, request.identity, request.correlationId),
    cancelQuery: (consumerKey) => worker.cancel(consumerKey),
    applyDelta: (request) => worker.applyDelta(request),
    admission: new WorkspacePathIndexAdmission(args.memoryBudgetBytes, args.memoryBudgetBytes * 2),
    peakBuildReservationBytes: Math.min(
      args.memoryBudgetBytes * 2,
      Math.max(args.memoryBudgetBytes, WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES)
    ),
    maxGenerationBytes: args.memoryBudgetBytes,
    onInstrumentation: recordEvent,
    disposeGeneration: (key) => {
      void worker.drop(key).catch(() => undefined)
    },
    dropRejectedGeneration: (key, generationId) => {
      void worker.drop(key, generationId).catch(() => undefined)
    },
    shutdownWorker: () => worker.dispose()
  })

  function recordEvent(event: WorkspacePathSearchInstrumentationEvent): void {
    if (event.kind === 'query-metrics') {
      metricsByCorrelation.set(event.record.correlationId, event.record)
    } else if (event.kind === 'maintenance') {
      maintenanceEvents.push(event.record)
    } else if (event.kind === 'stage-timing') {
      const stages = timingsByCorrelation.get(event.record.correlationId) ?? {}
      stages[event.record.stage] = event.record.duration.milliseconds
      timingsByCorrelation.set(event.record.correlationId, stages)
      if (event.record.stage === 'sort') {
        workerStageTimings.push({
          stage: event.record.stage,
          milliseconds: event.record.duration.milliseconds
        })
      }
    }
  }

  eventLoopDelay.enable()
  const ensureArgs = {
    owner,
    listingPolicyVersion: 'path-index-matrix-v1',
    foldVersion: `path-index-matrix-${WORKSPACE_PATH_INDEX_BENCHMARK_SEED}`,
    buildReservationBytes: args.memoryBudgetBytes,
    firstScope: 'included' as const,
    activeWorkspace: true,
    correlationId: `matrix-build-${args.size}-${args.profile}`
  }
  const initialEnsure = await service.ensure(ensureArgs)
  if (!initialEnsure.ready) {
    await buildComplete
  }
  eventLoopDelay.disable()
  let readyEnsure = await service.ensure(ensureArgs)
  for (let attempt = 0; !readyEnsure.ready && attempt < 100 && !observations.error; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    readyEnsure = await service.ensure(ensureArgs)
  }
  const ready = readyEnsure.ready && observations.outcome !== null
  await new Promise((resolve) => setTimeout(resolve, 20))
  const build = createWorkspacePathIndexBenchmarkBuildReport({
    size: args.size,
    memoryBudgetBytes: args.memoryBudgetBytes,
    observations,
    workerMemorySamples,
    workerStageTimings,
    eventLoopDelayMaximumMilliseconds: eventLoopDelay.max / 1_000_000
  })

  return {
    ready,
    maintenanceEvents,
    build,
    async search(queryClass: WorkspacePathIndexQueryClass) {
      const correlationId = `matrix-search-${args.size}-${sequence}`
      const identity: WorkspacePathSearchFenceIdentity = {
        query: getBenchmarkQueryText(args.profile, queryClass),
        consumer: { consumerId: 'path-index-matrix', sequence: ++sequence },
        owner,
        generationId: null,
        mode: 'name-filter',
        scope: {
          pathSet: 'all',
          includeDotfiles: true,
          includeIgnoredFiles: true,
          excludePathSegments: []
        },
        pageBudget: { maxPaths: 5_000, maxSerializedBytes: 1_000_000 }
      }
      metricsByCorrelation.delete(correlationId)
      const startedAt = performance.now()
      const result = await service.search({
        identity,
        listingPolicyVersion: ensureArgs.listingPolicyVersion,
        foldVersion: ensureArgs.foldVersion,
        buildReservationBytes: args.memoryBudgetBytes,
        correlationId
      })
      const serviceRoundTripMilliseconds = performance.now() - startedAt
      if (!result.ready) {
        return {
          serviceRoundTripMilliseconds,
          workerQueryMilliseconds: null,
          stageMilliseconds: timingsByCorrelation.get(correlationId) ?? {},
          overheadMilliseconds: {
            serviceEnsure: null,
            workerTransportAndQueue: null,
            serviceScheduling: null
          },
          strategy: null,
          storageMode: null,
          spillBlocksRead: null,
          spillBytesRead: null,
          decodedBlockCacheHits: null,
          pathsConsidered: null,
          candidates: null,
          verifications: null,
          exactMatches: null,
          retained: null,
          serializedBytes: null,
          ready: false,
          degradationReason: result.reason
        }
      }
      const metrics = metricsByCorrelation.get(correlationId)
      const stageMilliseconds = timingsByCorrelation.get(correlationId) ?? {}
      const workerQueryMilliseconds = stageMilliseconds['query-strategy'] ?? null
      const workerRoundTripMilliseconds = stageMilliseconds['worker-round-trip'] ?? null
      const serviceEnsureMilliseconds = stageMilliseconds['service-ensure'] ?? null
      return {
        serviceRoundTripMilliseconds,
        workerQueryMilliseconds,
        stageMilliseconds,
        overheadMilliseconds: {
          serviceEnsure: serviceEnsureMilliseconds,
          workerTransportAndQueue:
            workerRoundTripMilliseconds === null || workerQueryMilliseconds === null
              ? null
              : Math.max(0, workerRoundTripMilliseconds - workerQueryMilliseconds),
          serviceScheduling:
            workerRoundTripMilliseconds === null || serviceEnsureMilliseconds === null
              ? null
              : Math.max(
                  0,
                  serviceRoundTripMilliseconds -
                    workerRoundTripMilliseconds -
                    serviceEnsureMilliseconds
                )
        },
        strategy: metrics?.strategy ?? null,
        storageMode: metrics?.storageMode ?? null,
        spillBlocksRead: metrics?.spillBlocksRead ?? null,
        spillBytesRead: metrics?.spillBytesRead ?? null,
        decodedBlockCacheHits: metrics?.decodedBlockCacheHits ?? null,
        pathsConsidered: metrics?.pathsConsidered ?? null,
        candidates: metrics?.candidates ?? null,
        verifications: metrics?.verifications ?? null,
        exactMatches: metrics?.exactMatches ?? null,
        retained: metrics?.retained ?? result.response.retainedCount,
        serializedBytes: metrics?.serializedBytes ?? null,
        ready: true,
        degradationReason: null
      }
    },
    async applyDelta(mutations) {
      const startedAt = performance.now()
      const accepted = await service.applyDelta(
        owner,
        mutations,
        `matrix-delta-${args.size}-${sequence}`,
        true
      )
      return { publishMilliseconds: performance.now() - startedAt, accepted }
    },
    async dispose() {
      service.dispose()
      memoryChannel.port1.close()
      await spawnedWorker?.terminate().catch(() => undefined)
    }
  }
}
