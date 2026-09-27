import {
  sampleProcessMemoryUsage,
  WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES
} from '../../shared/__fixtures__/workspace-path-memory-measurement'
import type { BenchmarkBuildObservations } from './workspace-path-index-benchmark-build'
import type {
  WorkspacePathIndexBenchmarkSession,
  WorkerMemoryUsageSample
} from './workspace-path-index-benchmark-fixture'

/** Folds sampled host/worker memory into the matrix build report. */
export function createWorkspacePathIndexBenchmarkBuildReport(args: {
  size: number
  memoryBudgetBytes: number
  observations: BenchmarkBuildObservations
  workerMemorySamples: readonly WorkerMemoryUsageSample[]
  workerStageTimings: readonly { stage: string; milliseconds: number }[]
  eventLoopDelayMaximumMilliseconds: number
}): WorkspacePathIndexBenchmarkSession['build'] {
  const { observations, workerMemorySamples } = args
  const memorySamples = observations.memorySamples
  const memoryPeak = memorySamples.reduce(
    (peak, entry) => ({
      rssBytes: Math.max(peak.rssBytes, entry.rssBytes),
      heapUsedBytes: Math.max(peak.heapUsedBytes, entry.heapUsedBytes),
      externalBytes: Math.max(peak.externalBytes, entry.externalBytes),
      arrayBuffersBytes: Math.max(peak.arrayBuffersBytes, entry.arrayBuffersBytes)
    }),
    { rssBytes: 0, heapUsedBytes: 0, externalBytes: 0, arrayBuffersBytes: 0 }
  )
  const memoryBaseline = memorySamples[0] ?? {
    rssBytes: 0,
    heapUsedBytes: 0,
    externalBytes: 0,
    arrayBuffersBytes: 0
  }
  const workerMemoryBaseline = workerMemorySamples[0] ?? {
    heapUsedBytes: 0,
    externalBytes: 0,
    arrayBuffersBytes: 0
  }
  const workerMemoryPeak = workerMemorySamples.reduce(
    (peak, sample) => ({
      heapUsedBytes: Math.max(peak.heapUsedBytes, sample.heapUsedBytes),
      externalBytes: Math.max(peak.externalBytes, sample.externalBytes),
      arrayBuffersBytes: Math.max(peak.arrayBuffersBytes, sample.arrayBuffersBytes)
    }),
    { heapUsedBytes: 0, externalBytes: 0, arrayBuffersBytes: 0 }
  )
  const elapsed = Math.max(0, observations.finishedAt - observations.startedAt)
  return {
    durationMilliseconds: elapsed,
    firstScopeReadyMilliseconds:
      observations.firstScopeReadyAt === null
        ? null
        : observations.firstScopeReadyAt - observations.startedAt,
    allScopesReadyMilliseconds:
      observations.allScopesReadyAt === null
        ? null
        : observations.allScopesReadyAt - observations.startedAt,
    generatedPaths: args.size * 2,
    generatedPathsPerSecond: elapsed > 0 ? (args.size * 2 * 1_000) / elapsed : 0,
    retainedBytes: observations.outcome?.retainedBytes ?? 0,
    buildReservationBytes: args.memoryBudgetBytes,
    hostPeakBuildReservationBytes: Math.min(
      args.memoryBudgetBytes * 2,
      Math.max(args.memoryBudgetBytes, WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES)
    ),
    peakRssBytes: memoryPeak.rssBytes,
    peakRssDeltaBytes: memoryPeak.rssBytes - memoryBaseline.rssBytes,
    peakHostHeapUsedBytes: memoryPeak.heapUsedBytes,
    peakHostHeapUsedDeltaBytes: memoryPeak.heapUsedBytes - memoryBaseline.heapUsedBytes,
    peakHostExternalBytes: memoryPeak.externalBytes,
    peakHostExternalDeltaBytes: memoryPeak.externalBytes - memoryBaseline.externalBytes,
    peakHostArrayBuffersBytes: memoryPeak.arrayBuffersBytes,
    peakHostArrayBuffersDeltaBytes: memoryPeak.arrayBuffersBytes - memoryBaseline.arrayBuffersBytes,
    peakWorkerHeapUsedBytes: workerMemoryPeak.heapUsedBytes,
    peakWorkerHeapUsedDeltaBytes:
      workerMemoryPeak.heapUsedBytes - workerMemoryBaseline.heapUsedBytes,
    peakWorkerExternalBytes: workerMemoryPeak.externalBytes,
    peakWorkerExternalDeltaBytes:
      workerMemoryPeak.externalBytes - workerMemoryBaseline.externalBytes,
    peakWorkerArrayBuffersBytes: workerMemoryPeak.arrayBuffersBytes,
    peakWorkerArrayBuffersDeltaBytes:
      workerMemoryPeak.arrayBuffersBytes - workerMemoryBaseline.arrayBuffersBytes,
    steadyState: sampleProcessMemoryUsage(),
    steadyStateWorker: workerMemorySamples.at(-1) ?? null,
    cpuUserMicroseconds: observations.cpuUserMicroseconds,
    cpuSystemMicroseconds: observations.cpuSystemMicroseconds,
    eventLoopDelayMaximumMilliseconds: args.eventLoopDelayMaximumMilliseconds,
    memorySamples: memorySamples.map((entry) => ({
      elapsedMilliseconds: entry.elapsedMilliseconds - observations.startedAt,
      rssBytes: entry.rssBytes,
      heapUsedBytes: entry.heapUsedBytes,
      externalBytes: entry.externalBytes,
      arrayBuffersBytes: entry.arrayBuffersBytes
    })),
    workerMemorySamples,
    workerStageTimings: args.workerStageTimings,
    outcome: observations.outcome,
    degradationReason: observations.degradationReason,
    error: observations.error
  }
}
