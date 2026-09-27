import { mkdir, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRgArgsForQuickOpen } from '../../shared/quick-open-filter'
import { measureBuildPeakMemory } from '../../shared/__fixtures__/workspace-path-memory-measurement'
import { createFilesystemPathTreeFixture } from '../ipc/__fixtures__/filesystem-path-tree'
import { scanRipgrepPaths } from '../ipc/quick-open-rg-path-scan'
import {
  buildWorkspacePathIndexWorkerEntry,
  createPathIndexBenchmarkTemporaryDirectory,
  removePathIndexBenchmarkTemporaryDirectory
} from './workspace-path-index-benchmark-fixture'
import { WorkspacePathIndexWorkerClient } from './workspace-path-index-worker-client'

let activeWorker: WorkspacePathIndexWorkerClient | null = null
let activeMemoryPort: MessagePort | null = null

const runDiscoveryMatrix = process.env.ORCA_RUN_PATH_INDEX_DISCOVERY_MATRIX === '1'
const REPORT_PATH = join(process.cwd(), 'docs', 'perf', 'workspace-path-index-discovery.json')
const PATH_COUNT = 100_000
const DEFAULT_ROOT_BUDGET = 256 * 1024 * 1024

let temporaryDirectory: string | null = null
let fixtureCleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  activeWorker?.dispose()
  activeWorker = null
  activeMemoryPort?.close()
  activeMemoryPort = null
  await fixtureCleanup?.()
  fixtureCleanup = null
  if (temporaryDirectory) {
    await removePathIndexBenchmarkTemporaryDirectory(temporaryDirectory)
    temporaryDirectory = null
  }
})

type WorkerMemoryReading = {
  rssBytes: number
  heapUsedBytes: number
  externalBytes: number
  arrayBuffersBytes: number
}

function isWorkerMemorySample(value: unknown): value is WorkerMemoryReading {
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

describe.skipIf(!runDiscoveryMatrix)('workspace path index real discovery matrix', () => {
  it('scans a real deterministic 100k tree directly into the index worker', async () => {
    const fixture = await createFilesystemPathTreeFixture(PATH_COUNT)
    fixtureCleanup = fixture.cleanup
    temporaryDirectory = await createPathIndexBenchmarkTemporaryDirectory()
    const workerPath = await buildWorkspacePathIndexWorkerEntry(temporaryDirectory)
    const workerStages: { stage: string; milliseconds: number }[] = []
    const memoryChannel = new MessageChannel()
    activeMemoryPort = memoryChannel.port1
    const workerMemorySamples: {
      sampleSequence: number
      rssBytes: number
      heapUsedBytes: number
      externalBytes: number
      arrayBuffersBytes: number
    }[] = []
    memoryChannel.port1.on('message', (value: unknown) => {
      if (isWorkerMemorySample(value)) {
        workerMemorySamples.push({
          ...value,
          sampleSequence: workerMemorySamples.length + 1
        })
      }
    })
    const worker = new WorkspacePathIndexWorkerClient({
      workerFactory: () =>
        new Worker(workerPath, {
          workerData: { memoryPort: memoryChannel.port2 },
          transferList: [memoryChannel.port2]
        }),
      onInstrumentation: (event) => {
        if (event.kind === 'stage-timing' && event.record.stage === 'sort') {
          workerStages.push({
            stage: event.record.stage,
            milliseconds: event.record.duration.milliseconds
          })
        }
      }
    })
    activeWorker = worker
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 })
    let discoveredIncluded = 0
    let discoveredAll = 0
    let firstScopeReadyMilliseconds: number | null = null
    let allScopesReadyMilliseconds: number | null = null
    const cpuBefore = process.cpuUsage()
    const measurement = await measureBuildPeakMemory(async () => {
      const startedAt = performance.now()
      memoryChannel.port1.postMessage({ type: 'start' })
      const buildId = 'real-tree-build'
      await worker.beginCatalogBuild({
        key: 'real-tree-root',
        buildId,
        generationId: 'real-tree-generation',
        firstScope: 'included',
        maxBytes: DEFAULT_ROOT_BUDGET,
        correlationId: 'real-tree-discovery'
      })
      const rgArgs = buildRgArgsForQuickOpen({
        searchRoot: '.',
        excludePathPrefixes: [],
        forceSlashSeparator: sep === '\\'
      })
      eventLoopDelay.enable()
      await runPass(rgArgs.primary, 'included')
      const included = await worker.finishCatalogScope(buildId, 'included')
      firstScopeReadyMilliseconds = performance.now() - startedAt
      if (included.degradationReason) {
        throw new Error('Real-tree included scope exceeded the default root budget')
      }
      await runPass(rgArgs.ignoredPass, 'all')
      const all = await worker.finishCatalogScope(buildId, 'all')
      allScopesReadyMilliseconds = performance.now() - startedAt
      eventLoopDelay.disable()
      memoryChannel.port1.postMessage({ type: 'stop' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (all.degradationReason) {
        throw new Error('Real-tree all scope exceeded the default root budget')
      }
      return {
        startedAt,
        generationId: all.generationId,
        retainedBytes: all.retainedBytes
      }

      async function runPass(args: string[], pathSet: 'included' | 'all'): Promise<void> {
        await scanRipgrepPaths({
          args,
          authorizedRootPath: fixture.rootPath,
          excludePathPrefixes: [],
          localGitOptions: {},
          onPathBatch: async (paths) => {
            if (pathSet === 'included') {
              discoveredIncluded += paths.length
            } else {
              discoveredAll += paths.length
            }
            return worker.appendCatalogPathBatch(buildId, pathSet, paths)
          }
        })
      }
    }, 10)
    eventLoopDelay.disable()
    const cpu = process.cpuUsage(cpuBefore)
    const steadyState = process.memoryUsage()
    const workerMemoryBaseline = workerMemorySamples[0]
    const workerHeapPeak = Math.max(0, ...workerMemorySamples.map((sample) => sample.heapUsedBytes))
    const workerExternalPeak = Math.max(
      0,
      ...workerMemorySamples.map((sample) => sample.externalBytes)
    )
    const workerArrayBuffersPeak = Math.max(
      0,
      ...workerMemorySamples.map((sample) => sample.arrayBuffersBytes)
    )
    await mkdir(join(process.cwd(), 'docs', 'perf'), { recursive: true })
    await writeFile(
      REPORT_PATH,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          metadata: {
            platform: process.platform,
            architecture: process.arch,
            nodeVersion: process.version,
            buildMode: 'vitest-node-worker-thread-with-real-ripgrep',
            fixtureId: 'real-tree-100000',
            seed: 0x46535054,
            rootBudgetBytes: DEFAULT_ROOT_BUDGET,
            fixturePathsInArtifacts: false,
            rawSampleClock: 'host-monotonic-performance-now',
            memorySamplerIntervalMilliseconds: 10,
            discoveryThroughputIncludes:
              'ripgrep output, host batching, worker transfer, worker catalog sort'
          },
          pathCount: PATH_COUNT,
          discoveredIncluded,
          discoveredAll,
          firstScopeReadyMilliseconds,
          allScopesReadyMilliseconds,
          pathsPerSecondThroughAllPasses:
            measurement.durationMilliseconds > 0
              ? ((discoveredIncluded + discoveredAll) * 1_000) / measurement.durationMilliseconds
              : 0,
          durationMilliseconds: measurement.durationMilliseconds,
          retainedBytes: measurement.value.retainedBytes,
          peakRssBytes: measurement.peakRssBytes,
          peakHeapUsedBytes: measurement.peakHeapUsedBytes,
          peakExternalBytes: measurement.peakExternalBytes,
          peakRssDeltaBytes: measurement.peakRssBytes - measurement.baseline.rssBytes,
          peakHeapUsedDeltaBytes:
            measurement.peakHeapUsedBytes - measurement.baseline.heapUsedBytes,
          peakExternalDeltaBytes:
            measurement.peakExternalBytes - measurement.baseline.externalBytes,
          steadyStateMemoryBytes: {
            rssBytes: steadyState.rss,
            heapUsedBytes: steadyState.heapUsed,
            externalBytes: steadyState.external,
            arrayBuffersBytes: steadyState.arrayBuffers
          },
          cpuUserMicroseconds: cpu.user,
          cpuSystemMicroseconds: cpu.system,
          eventLoopDelayMaximumMilliseconds: eventLoopDelay.max / 1_000_000,
          workerStageTimings: workerStages,
          workerPeakHeapUsedBytes: workerHeapPeak,
          workerPeakHeapUsedDeltaBytes: workerHeapPeak - (workerMemoryBaseline?.heapUsedBytes ?? 0),
          workerPeakExternalBytes: workerExternalPeak,
          workerPeakExternalDeltaBytes:
            workerExternalPeak - (workerMemoryBaseline?.externalBytes ?? 0),
          workerPeakArrayBuffersBytes: workerArrayBuffersPeak,
          workerPeakArrayBuffersDeltaBytes:
            workerArrayBuffersPeak - (workerMemoryBaseline?.arrayBuffersBytes ?? 0),
          workerMemorySamples,
          memorySamples: measurement.samples.map((sample) => ({
            elapsedMilliseconds: sample.elapsedMilliseconds,
            rssBytes: sample.rssBytes,
            heapUsedBytes: sample.heapUsedBytes,
            externalBytes: sample.externalBytes,
            arrayBuffersBytes: sample.arrayBuffersBytes
          })),
          sortOwnership: 'worker-thread; main process only streams and awaits acknowledged batches',
          sortStagesOverOneSecond: workerStages.filter((stage) => stage.milliseconds >= 1_000)
            .length
        },
        null,
        2
      )}\n`
    )
    worker.dispose()
    activeWorker = null
    activeMemoryPort?.close()
    activeMemoryPort = null
    expect(discoveredIncluded).toBeGreaterThan(0)
    expect(allScopesReadyMilliseconds).not.toBeNull()
  }, 600_000)
})
