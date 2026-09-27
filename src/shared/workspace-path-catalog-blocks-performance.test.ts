import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateWorkspacePathCatalog } from './__fixtures__/workspace-path-catalog'
import {
  measureBuildPeakMemory,
  type ProcessMemorySample
} from './__fixtures__/workspace-path-memory-measurement'
import type { WorkspacePathCatalogStorage } from './workspace-path-catalog-builder'
import { WorkspacePathCatalogBuilder } from './workspace-path-catalog-builder'
import { queryWorkspacePathCatalog } from './workspace-path-catalog-query'
import type { WorkspacePathSearchFenceIdentity } from './workspace-path-search-contract'
import type { WorkspacePathSearchQueryMetrics } from './workspace-path-search-instrumentation'

const RUN_BLOCKS_BENCHMARK = process.env.ORCA_RUN_PATH_CATALOG_BLOCKS_BENCHMARK === '1'
const BENCHMARK_PATH_COUNT = Number(process.env.ORCA_PATH_CATALOG_BLOCKS_SIZE ?? 100_000)
const PROFILES = ['realistic-shared-prefixes', 'adversarial-long-unshared'] as const
const STORAGE_MODES: readonly WorkspacePathCatalogStorage[] = ['packed-folded', 'prefix-compressed']
const QUERY_CLASSES = [
  { queryClass: 'broad-one-character', query: 'a' },
  { queryClass: 'no-match', query: 'path-index-never-matches-this-token' },
  { queryClass: 'selective-three-character', query: 'tsx' },
  { queryClass: 'multi-token-and', query: 'workspace target' },
  { queryClass: 'long-path', query: 'unshared-segment-0000000' },
  { queryClass: 'unicode', query: 'İstanbul' },
  { queryClass: 'extension-fragment', query: '.tsx' },
  { queryClass: 'directory-fragment', query: 'src/shared' },
  { queryClass: 'slash-spanning-fragment', query: 'alpha/unshared-segment' }
] as const

type Measurement = {
  profile: (typeof PROFILES)[number]
  storage: WorkspacePathCatalogStorage
  pathCount: number
  retainedBytes: number
  retainedMiB: number
  peakRssBytes: number
  peakRssDeltaBytes: number
  peakHeapUsedBytes: number
  peakHeapUsedDeltaBytes: number
  peakExternalBytes: number
  peakExternalDeltaBytes: number
  buildMilliseconds: number
  memorySamples: readonly ProcessMemorySample[]
  warmQueries: {
    queryClass: string
    p50Milliseconds: number
    p95Milliseconds: number
    maxMilliseconds: number
    rawMilliseconds: number[]
    storageSamples: {
      storageMode: string | null
      spillBlocksRead: number
      spillBytesRead: number
      decodedBlockCacheHits: number
    }[]
  }[]
}

describe.skipIf(!RUN_BLOCKS_BENCHMARK)('workspace path catalog block performance matrix', () => {
  it('records packed and prefix-compressed footprints and warm samples for both profiles', async () => {
    const measurements: Measurement[] = []
    for (const profile of PROFILES) {
      for (const storage of STORAGE_MODES) {
        measurements.push(await measureCatalog(profile, storage))
      }
    }
    for (const profile of PROFILES) {
      const packed = measurements.find(
        (measurement) => measurement.profile === profile && measurement.storage === 'packed-folded'
      )
      const compressed = measurements.find(
        (measurement) =>
          measurement.profile === profile && measurement.storage === 'prefix-compressed'
      )
      expect(packed).toBeDefined()
      expect(compressed).toBeDefined()
      if (packed && compressed) {
        expect(compressed.retainedBytes).toBeGreaterThan(0)
      }
    }
    const outputPath = join(
      process.cwd(),
      'docs',
      'perf',
      'workspace-path-catalog-blocks-phase6b.json'
    )
    await mkdir(join(process.cwd(), 'docs', 'perf'), { recursive: true })
    await writeFile(
      outputPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          campaign: 'workspace-path-catalog-blocks-phase6b',
          baseline: 'workspace-path-index-matrix-phase6a.json',
          profiles: PROFILES,
          pathCount: BENCHMARK_PATH_COUNT,
          samplesPerQueryClass: 7,
          rootBudgetBytes: 256 * 1024 * 1024,
          hostBudgetBytes: 512 * 1024 * 1024,
          hostTotalMemoryBytes: totalmem(),
          measurements
        },
        null,
        2
      )}\n`
    )
    console.info(`[workspace-path-catalog-blocks-phase6b] ${JSON.stringify(measurements)}`)
  }, 900_000)
})

async function measureCatalog(
  profile: (typeof PROFILES)[number],
  storage: WorkspacePathCatalogStorage
): Promise<Measurement> {
  const measured = await measureBuildPeakMemory(async () => {
    const builder = new WorkspacePathCatalogBuilder({
      generationId: `catalog-block-benchmark-${profile}-${storage}`,
      maxBytes: 1024 * 1024 * 1024,
      storage,
      freshness: 'no-known-gap'
    })
    for (const path of generateWorkspacePathCatalog({
      size: Math.ceil(BENCHMARK_PATH_COUNT * 1.4),
      profile,
      seed: 0x50455246
    })) {
      if (!builder.addPath(path, 'all')) {
        throw new Error(`Builder rejected ${profile} at ${builder.pathCount} paths`)
      }
      if (builder.pathCount === BENCHMARK_PATH_COUNT) {
        break
      }
      if (builder.pathCount % 20_000 === 0) {
        await yieldToEventLoop()
      }
    }
    if (builder.pathCount !== BENCHMARK_PATH_COUNT) {
      throw new Error(`Fixture did not yield ${BENCHMARK_PATH_COUNT} eligible paths`)
    }
    builder.markScopeComplete('all')
    const catalog = builder.finish()
    if (!catalog) {
      throw new Error(`${profile} ${storage} catalog failed publication`)
    }
    return catalog
  }, 10)
  const warmQueries: Measurement['warmQueries'] = []
  for (const queryCase of QUERY_CLASSES) {
    const rawMilliseconds: number[] = []
    const storageSamples: WorkspacePathSearchQueryMetrics[] = []
    for (let sample = 0; sample < 7; sample += 1) {
      const startedAt = performance.now()
      const result = await queryWorkspacePathCatalog(measured.value, {
        identity: benchmarkIdentity(queryCase.query),
        onInstrumentation: (event) => {
          if (event.kind === 'query-metrics') {
            storageSamples.push(event.record)
          }
        }
      })
      rawMilliseconds.push(performance.now() - startedAt)
      expect(result.count.provenance).toBe('exact-snapshot')
    }
    const sorted = [...rawMilliseconds].sort((left, right) => left - right)
    warmQueries.push({
      queryClass: queryCase.queryClass,
      p50Milliseconds: percentile(sorted, 0.5),
      p95Milliseconds: percentile(sorted, 0.95),
      maxMilliseconds: sorted.at(-1) ?? 0,
      rawMilliseconds,
      storageSamples: storageSamples.map((sample) => ({
        storageMode: sample.storageMode ?? null,
        spillBlocksRead: sample.spillBlocksRead ?? 0,
        spillBytesRead: sample.spillBytesRead ?? 0,
        decodedBlockCacheHits: sample.decodedBlockCacheHits ?? 0
      }))
    })
  }
  return {
    profile,
    storage,
    pathCount: measured.value.pathCount,
    retainedBytes: measured.value.retainedBytes,
    retainedMiB: measured.value.retainedBytes / (1024 * 1024),
    peakRssBytes: measured.peakRssBytes,
    peakRssDeltaBytes: measured.peakRssBytes - measured.baseline.rssBytes,
    peakHeapUsedBytes: measured.peakHeapUsedBytes,
    peakHeapUsedDeltaBytes: measured.peakHeapUsedBytes - measured.baseline.heapUsedBytes,
    peakExternalBytes: measured.peakExternalBytes,
    peakExternalDeltaBytes: measured.peakExternalBytes - measured.baseline.externalBytes,
    buildMilliseconds: measured.durationMilliseconds,
    memorySamples: measured.samples,
    warmQueries
  }
}

function benchmarkIdentity(query: string): WorkspacePathSearchFenceIdentity {
  return {
    query,
    consumer: { consumerId: 'catalog-block-benchmark', sequence: 1 },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'block-benchmark' },
      authorizedCanonicalRoot: '/fixture'
    },
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
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0
}
