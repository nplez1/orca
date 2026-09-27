import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspacePathCatalogBuilder } from './workspace-path-catalog-builder'
import type { WorkspacePathCatalogStorage } from './workspace-path-catalog-builder'
import type { WorkspacePathSearchFenceIdentity } from './workspace-path-search-contract'
import { queryWorkspacePathCatalog } from './workspace-path-catalog-query'
import { generateWorkspacePathCatalog } from './__fixtures__/workspace-path-catalog'
import {
  estimateRetainedPathCatalogBytes,
  measureBuildPeakMemory,
  WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
} from './__fixtures__/workspace-path-memory-measurement'

const STORAGE_BENCHMARK_PATH_COUNT = 100_000
const STORAGE_QUERY_CLASSES = [
  { queryClass: 'broad-one-character', query: 'a' },
  { queryClass: 'no-match', query: 'no-such-token-in-this-catalog' },
  { queryClass: 'selective-three-character', query: 'tsx' },
  { queryClass: 'long-path', query: 'budget target' }
] as const

type StorageBenchmarkResult = {
  storage: WorkspacePathCatalogStorage
  pathCount: number
  retainedBytes: number
  foldedStringFootprintBytes: number
  peakRssBytes: number
  peakRssDeltaBytes: number
  peakHeapUsedBytes: number
  peakHeapUsedDeltaBytes: number
  peakExternalBytes: number
  peakExternalDeltaBytes: number
  durationMilliseconds: number
  warmQuerySamples: {
    queryClass: string
    p50Milliseconds: number
    p95Milliseconds: number
    maxMilliseconds: number
    rawMilliseconds: number[]
  }[]
}

describe('workspace path catalog storage benchmark', () => {
  it('compares retained string headers with packed folded code units', async () => {
    const results = [
      await benchmarkStorage('folded-strings'),
      await benchmarkStorage('packed-folded')
    ]
    const plain = results.find((result) => result.storage === 'folded-strings')
    const packed = results.find((result) => result.storage === 'packed-folded')
    expect(plain).toBeDefined()
    expect(packed).toBeDefined()
    if (!plain || !packed) {
      throw new Error('Expected both catalog storage measurements')
    }
    expect(packed.retainedBytes).toBeLessThan(plain.retainedBytes)
    const outputPath = join(process.cwd(), 'docs', 'perf', 'workspace-path-catalog-storage.json')
    await mkdir(join(process.cwd(), 'docs', 'perf'), { recursive: true })
    await writeFile(
      outputPath,
      `${JSON.stringify(
        {
          fixture: 'realistic-shared-prefixes',
          pathCount: STORAGE_BENCHMARK_PATH_COUNT,
          retainedFootprintIncludes:
            'packed original UTF-8, typed-array bytes, folded string headers, and folded array references',
          stringFootprintFormula: 'path.length * 2 + 48 bytes per retained folded string',
          measurements: results
        },
        null,
        2
      )}\n`
    )
    console.info(`[path-catalog-storage] ${JSON.stringify(results)}`)
  }, 120_000)
})

async function benchmarkStorage(
  storage: WorkspacePathCatalogStorage
): Promise<StorageBenchmarkResult> {
  const measurement = await measureBuildPeakMemory(async () => {
    const builder = new WorkspacePathCatalogBuilder({
      generationId: `storage-benchmark-${storage}`,
      maxBytes: WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES,
      storage,
      freshness: 'no-known-gap'
    })
    let discovered = 0
    for (const path of generateWorkspacePathCatalog({
      size: Math.ceil(STORAGE_BENCHMARK_PATH_COUNT * 1.3),
      profile: 'realistic-shared-prefixes',
      seed: 0x50455246
    })) {
      if (!builder.addPath(path, 'all')) {
        throw new Error(`Storage benchmark admission failed for ${storage}`)
      }
      discovered += 1
      if (builder.pathCount === STORAGE_BENCHMARK_PATH_COUNT) {
        break
      }
      if (discovered % 20_000 === 0) {
        await yieldToEventLoop()
      }
    }
    if (builder.pathCount !== STORAGE_BENCHMARK_PATH_COUNT) {
      throw new Error(`Expected ${STORAGE_BENCHMARK_PATH_COUNT} eligible paths`)
    }
    builder.markScopeComplete('all')
    const catalog = builder.finish()
    if (!catalog) {
      throw new Error(`Storage benchmark publication failed for ${storage}`)
    }
    return catalog
  }, 5)
  const identity = createStorageBenchmarkIdentity()
  const warmQuerySamples: StorageBenchmarkResult['warmQuerySamples'] = []
  for (const queryCase of STORAGE_QUERY_CLASSES) {
    const rawMilliseconds: number[] = []
    for (let sample = 0; sample < 7; sample += 1) {
      const startedAt = performance.now()
      const response = await queryWorkspacePathCatalog(measurement.value, {
        identity: { ...identity, query: queryCase.query }
      })
      rawMilliseconds.push(performance.now() - startedAt)
      if (response.count.provenance !== 'exact-snapshot') {
        throw new Error(`Expected exact ${queryCase.queryClass} sample`)
      }
    }
    const sorted = [...rawMilliseconds].sort((left, right) => left - right)
    warmQuerySamples.push({
      queryClass: queryCase.queryClass,
      p50Milliseconds: percentile(sorted, 0.5),
      p95Milliseconds: percentile(sorted, 0.95),
      maxMilliseconds: sorted.at(-1) ?? 0,
      rawMilliseconds
    })
  }
  return {
    storage,
    pathCount: measurement.value.pathCount,
    retainedBytes: measurement.value.retainedBytes,
    foldedStringFootprintBytes:
      measurement.value.storageKind === 'folded-strings'
        ? estimateRetainedPathCatalogBytes(measurement.value.foldedPaths)
        : 0,
    peakRssBytes: measurement.peakRssBytes,
    peakRssDeltaBytes: measurement.peakRssBytes - measurement.baseline.rssBytes,
    peakHeapUsedBytes: measurement.peakHeapUsedBytes,
    peakHeapUsedDeltaBytes: measurement.peakHeapUsedBytes - measurement.baseline.heapUsedBytes,
    peakExternalBytes: measurement.peakExternalBytes,
    peakExternalDeltaBytes: measurement.peakExternalBytes - measurement.baseline.externalBytes,
    durationMilliseconds: measurement.durationMilliseconds,
    warmQuerySamples
  }
}

function createStorageBenchmarkIdentity(): WorkspacePathSearchFenceIdentity {
  return {
    query: '',
    consumer: { consumerId: 'catalog-storage-benchmark', sequence: 1 },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'benchmark-host' },
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

function percentile(sortedSamples: readonly number[], percentileValue: number): number {
  return sortedSamples[Math.max(0, Math.ceil(sortedSamples.length * percentileValue) - 1)] ?? 0
}
