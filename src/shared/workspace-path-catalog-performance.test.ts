import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkspacePathSearchFenceIdentity } from './workspace-path-search-contract'
import { WorkspacePathCatalogBuilder } from './workspace-path-catalog-builder'
import { queryWorkspacePathCatalog } from './workspace-path-catalog-query'
import { generateWorkspacePathCatalog } from './__fixtures__/workspace-path-catalog'
import { measureBuildPeakMemory } from './__fixtures__/workspace-path-memory-measurement'

const runCatalogBenchmark = process.env.ORCA_RUN_PATH_SEARCH_CATALOG_BENCHMARK === '1'
const QUERY_CLASSES = [
  { name: 'broad-one-character', query: 'a' },
  { name: 'no-match', query: 'no-such-token-in-this-catalog' },
  { name: 'selective-three-character', query: 'tsx' },
  { name: 'long-path', query: 'budget target' }
] as const
const WARM_SAMPLE_COUNT = 15

type QuerySamples = {
  queryClass: string
  exactCount: number
  p50Milliseconds: number
  p95Milliseconds: number
  maxMilliseconds: number
  rawMilliseconds: number[]
}

describe.skipIf(!runCatalogBenchmark)('workspace path catalog warm-query performance', () => {
  it.each([300_000, 500_000, 1_000_000])(
    'records the ordered-scan workload at %i paths',
    async (size) => {
      const measured = await measureBuildPeakMemory(async () => {
        const builder = new WorkspacePathCatalogBuilder({
          generationId: `query-benchmark-${size}`,
          maxBytes: 2 * 1024 * 1024 * 1024,
          storage: 'folded-strings',
          freshness: 'no-known-gap'
        })
        let discovered = 0
        for (const path of generateWorkspacePathCatalog({
          size: Math.ceil(size * 1.3),
          profile: 'realistic-shared-prefixes',
          seed: 0x50455246
        })) {
          if (!builder.addPath(path, 'all')) {
            throw new Error(`Benchmark catalog admission failed at ${size} paths`)
          }
          discovered += 1
          if (builder.pathCount === size) {
            break
          }
          if (discovered % 20_000 === 0) {
            await yieldToEventLoop()
          }
        }
        if (builder.pathCount !== size) {
          throw new Error(`Expected ${size} eligible paths, got ${builder.pathCount}`)
        }
        builder.markScopeComplete('all')
        const buildReservationBytes = builder.admissionBytes
        const catalog = builder.finish()
        if (!catalog) {
          throw new Error(`Benchmark catalog publication failed at ${size} paths`)
        }
        return { catalog, buildReservationBytes }
      }, 10)
      const identityBase = createBenchmarkIdentity()
      const queryResults: QuerySamples[] = []
      for (const queryCase of QUERY_CLASSES) {
        const rawMilliseconds: number[] = []
        let exactCount = 0
        for (let sample = 0; sample < WARM_SAMPLE_COUNT; sample += 1) {
          const startedAt = performance.now()
          const response = await queryWorkspacePathCatalog(measured.value.catalog, {
            identity: { ...identityBase, query: queryCase.query }
          })
          rawMilliseconds.push(performance.now() - startedAt)
          exactCount = response.count.value ?? -1
          if (response.count.provenance !== 'exact-snapshot') {
            throw new Error(`Warm query was not exact for the ${queryCase.name} workload`)
          }
        }
        queryResults.push(summarizeSamples(queryCase.name, exactCount, rawMilliseconds))
      }
      const report = {
        host: {
          platform: process.platform,
          architecture: process.arch,
          nodeVersion: process.version
        },
        fixture: 'realistic-shared-prefixes',
        storage: 'folded-strings',
        strategy: 'ordered-scan',
        generatedPathCount: size,
        admittedCatalogPathCount: measured.value.catalog.pathCount,
        retainedBytes: measured.value.catalog.retainedBytes,
        buildReservationBytes: measured.value.buildReservationBytes,
        defaultRootBudgetBytes: 256 * 1024 * 1024,
        hostPeakBudgetBytes: 512 * 1024 * 1024,
        fitsDefaultRootBudget: measured.value.catalog.retainedBytes <= 256 * 1024 * 1024,
        fitsDefaultRootBuildReservation: measured.value.buildReservationBytes <= 256 * 1024 * 1024,
        fitsHostBuildReservation: measured.value.buildReservationBytes <= 512 * 1024 * 1024,
        peakRssFitsHostBudget: measured.peakRssBytes <= 512 * 1024 * 1024,
        build: {
          durationMilliseconds: measured.durationMilliseconds,
          peakRssBytes: measured.peakRssBytes,
          peakRssDeltaBytes: measured.peakRssBytes - measured.baseline.rssBytes,
          peakHeapUsedBytes: measured.peakHeapUsedBytes,
          peakExternalBytes: measured.peakExternalBytes,
          samples: measured.samples.map((entry) => ({
            elapsedMilliseconds: entry.elapsedMilliseconds,
            rssBytes: entry.rssBytes,
            heapUsedBytes: entry.heapUsedBytes,
            externalBytes: entry.externalBytes,
            arrayBuffersBytes: entry.arrayBuffersBytes
          }))
        },
        warmQueries: queryResults,
        hostTargetsMilliseconds: {
          upTo500kP95: 25,
          oneMillionP95: 60
        }
      }
      await mkdir(join(process.cwd(), 'docs', 'perf'), { recursive: true })
      await writeFile(
        join(process.cwd(), 'docs', 'perf', `workspace-path-catalog-query-${size}.json`),
        `${JSON.stringify(report, null, 2)}\n`
      )
      console.info(`[path-catalog-query-perf] ${JSON.stringify(report)}`)
      expect(queryResults).toHaveLength(QUERY_CLASSES.length)
    },
    900_000
  )
})

function createBenchmarkIdentity(): WorkspacePathSearchFenceIdentity {
  return {
    query: '',
    consumer: { consumerId: 'catalog-performance', sequence: 1 },
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

function summarizeSamples(queryClass: string, exactCount: number, samples: number[]): QuerySamples {
  const sortedSamples = [...samples].sort((left, right) => left - right)
  return {
    queryClass,
    exactCount,
    p50Milliseconds: percentile(sortedSamples, 0.5),
    p95Milliseconds: percentile(sortedSamples, 0.95),
    maxMilliseconds: sortedSamples.at(-1) ?? 0,
    rawMilliseconds: samples
  }
}

function percentile(sortedSamples: readonly number[], percentileValue: number): number {
  const index = Math.max(0, Math.ceil(sortedSamples.length * percentileValue) - 1)
  return sortedSamples[index] ?? 0
}
