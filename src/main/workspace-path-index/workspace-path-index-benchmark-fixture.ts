import { build } from 'esbuild'
import { mkdir, rm, mkdtemp } from 'node:fs/promises'
import { availableParallelism, cpus, freemem, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import type { sampleProcessMemoryUsage } from '../../shared/__fixtures__/workspace-path-memory-measurement'
import type {
  WorkspacePathSearchMaintenanceEvent,
  WorkspacePathSearchTimingStage
} from '../../shared/workspace-path-search-instrumentation'
import type { WorkspacePathIndexService } from './workspace-path-index-service'
import type { WorkspacePathCatalogShape } from '../../shared/__fixtures__/workspace-path-catalog'

export const WORKSPACE_PATH_INDEX_BENCHMARK_SIZES = [100_000, 300_000, 500_000, 1_000_000] as const
export const WORKSPACE_PATH_INDEX_BENCHMARK_SHAPES: readonly WorkspacePathCatalogShape[] = [
  'realistic-shared-prefixes',
  'adversarial-long-unshared'
]
export const WORKSPACE_PATH_INDEX_BENCHMARK_REPETITIONS = 5
export const WORKSPACE_PATH_INDEX_BENCHMARK_MILLION_REPETITIONS = 3
export const WORKSPACE_PATH_INDEX_BENCHMARK_SEED = 0x50455246
export const MEBIBYTE = 1024 * 1024

export const WORKSPACE_PATH_INDEX_QUERY_CLASSES = [
  'broad-one-character',
  'no-match',
  'selective-three-character',
  'multi-token-and',
  'long-path',
  'unicode',
  'extension-fragment',
  'directory-fragment',
  'slash-spanning-fragment'
] as const

export type WorkspacePathIndexQueryClass = (typeof WORKSPACE_PATH_INDEX_QUERY_CLASSES)[number]
export type WorkerMemoryUsageSample = {
  sampleSequence: number
  rssBytes: number
  heapUsedBytes: number
  externalBytes: number
  arrayBuffersBytes: number
}
export type BenchmarkBuildOutcome = {
  generationId: string
  retainedBytes: number
  trigramPostingsBytes: number
  storageMode?: 'packed-folded' | 'disk-spilled'
  spillFileBytes?: number
  degradationReason?: string
}
export type WorkspacePathIndexBenchmarkSession = {
  ready: boolean
  maintenanceEvents: WorkspacePathSearchMaintenanceEvent[]
  build: {
    durationMilliseconds: number
    firstScopeReadyMilliseconds: number | null
    allScopesReadyMilliseconds: number | null
    generatedPaths: number
    generatedPathsPerSecond: number
    retainedBytes: number
    buildReservationBytes: number
    hostPeakBuildReservationBytes: number
    peakRssBytes: number
    peakRssDeltaBytes: number
    peakHostHeapUsedBytes: number
    peakHostHeapUsedDeltaBytes: number
    peakHostExternalBytes: number
    peakHostExternalDeltaBytes: number
    peakHostArrayBuffersBytes: number
    peakHostArrayBuffersDeltaBytes: number
    peakWorkerHeapUsedBytes: number
    peakWorkerHeapUsedDeltaBytes: number
    peakWorkerExternalBytes: number
    peakWorkerExternalDeltaBytes: number
    peakWorkerArrayBuffersBytes: number
    peakWorkerArrayBuffersDeltaBytes: number
    steadyState: ReturnType<typeof sampleProcessMemoryUsage>
    steadyStateWorker: WorkerMemoryUsageSample | null
    cpuUserMicroseconds: number
    cpuSystemMicroseconds: number
    eventLoopDelayMaximumMilliseconds: number
    memorySamples: readonly {
      elapsedMilliseconds: number
      rssBytes: number
      heapUsedBytes: number
      externalBytes: number
      arrayBuffersBytes: number
    }[]
    workerMemorySamples: readonly WorkerMemoryUsageSample[]
    workerStageTimings: readonly { stage: string; milliseconds: number }[]
    outcome: BenchmarkBuildOutcome | null
    degradationReason: string | null
    error: string | null
  }
  search(queryClass: WorkspacePathIndexQueryClass): Promise<{
    serviceRoundTripMilliseconds: number
    workerQueryMilliseconds: number | null
    stageMilliseconds: Partial<Record<WorkspacePathSearchTimingStage, number>>
    overheadMilliseconds: {
      serviceEnsure: number | null
      workerTransportAndQueue: number | null
      serviceScheduling: number | null
    }
    strategy: string | null
    storageMode: string | null
    spillBlocksRead: number | null
    spillBytesRead: number | null
    decodedBlockCacheHits: number | null
    pathsConsidered: number | null
    candidates: number | null
    verifications: number | null
    exactMatches: number | null
    retained: number | null
    serializedBytes: number | null
    ready: boolean
    degradationReason: string | null
  }>
  applyDelta(mutations: Parameters<WorkspacePathIndexService['applyDelta']>[1]): Promise<{
    publishMilliseconds: number
    accepted: boolean
  }>
  dispose(): Promise<void>
}

const QUERY_TEXT: Record<
  WorkspacePathCatalogShape,
  Record<WorkspacePathIndexQueryClass, string>
> = {
  'realistic-shared-prefixes': {
    'broad-one-character': 'a',
    'no-match': 'path-index-never-matches-this-token',
    'selective-three-character': 'tsx',
    'multi-token-and': 'src component',
    'long-path': 'budget target',
    unicode: 'İstanbul',
    'extension-fragment': '.tsx',
    'directory-fragment': 'src/shared',
    'slash-spanning-fragment': 'components/button'
  },
  'adversarial-long-unshared': {
    'broad-one-character': 'a',
    'no-match': 'path-index-never-matches-this-token',
    'selective-three-character': 'tsx',
    'multi-token-and': 'workspace unshared-segment',
    'long-path': 'unshared-segment-0000000',
    unicode: 'İstanbul',
    'extension-fragment': '.tsx',
    'directory-fragment': 'workspace-',
    'slash-spanning-fragment': 'alpha/unshared-segment'
  }
}

export function getBenchmarkQueryText(
  shape: WorkspacePathCatalogShape,
  queryClass: WorkspacePathIndexQueryClass
): string {
  return QUERY_TEXT[shape][queryClass]
}

export async function buildWorkspacePathIndexWorkerEntry(
  temporaryDirectory: string
): Promise<string> {
  await mkdir(temporaryDirectory, { recursive: true })
  const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
  await build({
    entryPoints: [resolve(__dirname, 'workspace-path-index-benchmark-worker-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: workerPath
  })
  return workerPath
}

export async function createPathIndexBenchmarkTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orca-path-index-matrix-'))
}

export async function removePathIndexBenchmarkTemporaryDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

export function describeBenchmarkMachine(): {
  platform: string
  architecture: string
  nodeVersion: string
  nodeMajorVersion: number
  cpuModel: string
  logicalCpuCount: number
  availableParallelism: number
  totalMemoryBytes: number
  freeMemoryBytesAtStart: number
  buildMode: string
} {
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    nodeMajorVersion: Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10),
    cpuModel: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length,
    availableParallelism: availableParallelism(),
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
    buildMode: 'vitest-node-worker-thread'
  }
}

export function isWorkerMemoryReading(
  value: unknown
): value is Omit<WorkerMemoryUsageSample, 'sampleSequence'> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (
    'rssBytes' in value &&
    typeof value.rssBytes === 'number' &&
    'heapUsedBytes' in value &&
    typeof value.heapUsedBytes === 'number' &&
    'externalBytes' in value &&
    typeof value.externalBytes === 'number' &&
    'arrayBuffersBytes' in value &&
    typeof value.arrayBuffersBytes === 'number'
  )
}

export type { WorkspacePathCatalogShape }
