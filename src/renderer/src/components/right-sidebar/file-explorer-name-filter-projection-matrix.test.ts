// @vitest-environment happy-dom
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { workspacePathCatalogJsonStringByteLength } from '../../../../shared/workspace-path-catalog-query'
import type {
  WorkspacePathSearchResponse,
  WorkspacePathSearchRowClassificationFlags
} from '../../../../shared/workspace-path-search-contract'
import {
  createNameFilteredFileExplorerProjection,
  createNameFilteredFileExplorerProjectionInChunks,
  getFileExplorerNameFilterProjectionEstimatedBytes
} from './file-explorer-name-filter-projection'
import {
  recordRendererPathSearchCommit,
  recordRendererPathSearchDuration,
  markRendererPathSearchProjectionReady,
  recordRendererPathSearchProjectionChunk
} from './file-explorer-name-filter-timing'

const runProjectionMatrix = process.env.ORCA_RUN_PATH_INDEX_PROJECTION_MATRIX === '1'
const REPORT_PATH = join(
  process.cwd(),
  'docs',
  'perf',
  'workspace-path-index-renderer-projection-optimization.json'
)
const PAGE_LEAVES = 5_000
const WARM_REPETITIONS = 5
const COMMITTED_VIRTUAL_ROWS = 100
const PROJECTION_BYTE_BUDGET = 256 * 1024

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type ProjectionCase = {
  fixtureId:
    | 'shallow-5000-leaves'
    | 'ancestor-heavy-deep-5000-leaves'
    | 'byte-limited-page'
    | 'deep-chain-shared-prefix-5000-leaves'
  paths: readonly string[]
  requestedPageBytes: number | null
}

type TimingSample = {
  projectionMilliseconds: number
  synchronousProjectionMilliseconds: number
  projectionChunkCount: number
  maxProjectionChunkMilliseconds: number
  projectionChunkDurations: number[]
  commitMilliseconds: number
  domTwoFrameMilliseconds: number | null
  estimatedProjectionBytes: number
  projectedRowCount: number
  committedRowCount: number
}

type TimingDistribution = {
  p50Milliseconds: number
  p95Milliseconds: number
  maxMilliseconds: number
}

const BEFORE_SYNCHRONOUS_PROJECTION: Record<ProjectionCase['fixtureId'], TimingDistribution> = {
  'shallow-5000-leaves': {
    p50Milliseconds: 5.63075,
    p95Milliseconds: 9.160166,
    maxMilliseconds: 9.160166
  },
  'ancestor-heavy-deep-5000-leaves': {
    p50Milliseconds: 33.472292,
    p95Milliseconds: 46.988375,
    maxMilliseconds: 46.988375
  },
  'byte-limited-page': {
    p50Milliseconds: 3.204042,
    p95Milliseconds: 3.490291,
    maxMilliseconds: 3.490291
  },
  'deep-chain-shared-prefix-5000-leaves': {
    p50Milliseconds: 182.375791,
    p95Milliseconds: 190.009875,
    maxMilliseconds: 190.009875
  }
}

describe.skipIf(!runProjectionMatrix)('workspace path index renderer projection matrix', () => {
  it('measures projection and virtual-page commit in happy-dom with Phase 4 timing hooks', async () => {
    const cases = createProjectionCases()
    const reports: Record<string, unknown>[] = []
    for (const testCase of cases) {
      const samples: TimingSample[] = []
      for (let sample = 0; sample < WARM_REPETITIONS; sample += 1) {
        samples.push(await measureProjection(testCase, sample))
      }
      const projectionValues = samples
        .map((sample) => sample.projectionMilliseconds)
        .sort((a, b) => a - b)
      const commitValues = samples.map((sample) => sample.commitMilliseconds).sort((a, b) => a - b)
      const frameValues = samples
        .map((sample) => sample.domTwoFrameMilliseconds)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b)
      reports.push({
        fixtureId: testCase.fixtureId,
        beforeSynchronousProjectionTask: BEFORE_SYNCHRONOUS_PROJECTION[testCase.fixtureId],
        inputLeafCount: testCase.paths.length,
        requestedPageBytes: testCase.requestedPageBytes,
        sampleCount: samples.length,
        projection: summarize(projectionValues),
        synchronousProjection: summarize(
          samples.map((sample) => sample.synchronousProjectionMilliseconds).sort((a, b) => a - b)
        ),
        projectionTaskSlice: summarize(
          samples.flatMap((sample) => sample.projectionChunkDurations).sort((a, b) => a - b)
        ),
        projectionCpu: summarize(
          samples
            .map((sample) =>
              sample.projectionChunkDurations.reduce(
                (total, milliseconds) => total + milliseconds,
                0
              )
            )
            .sort((a, b) => a - b)
        ),
        projectionTaskP95Verdict:
          percentile(
            samples.flatMap((sample) => sample.projectionChunkDurations).sort((a, b) => a - b),
            0.95
          ) <= 16
            ? 'pass'
            : 'miss',
        maximumTaskSlicePerRun: summarize(
          samples.map((sample) => sample.maxProjectionChunkMilliseconds).sort((a, b) => a - b)
        ),
        projectionChunkCountMean:
          samples.reduce((total, sample) => total + sample.projectionChunkCount, 0) /
          samples.length,
        virtualPageCommit: summarize(commitValues),
        domTwoFrame: summarize(frameValues),
        targetMilliseconds: 16,
        projectionP95Verdict: percentile(projectionValues, 0.95) <= 16 ? 'pass' : 'miss',
        commitP95Verdict: percentile(commitValues, 0.95) <= 16 ? 'pass' : 'miss',
        domCaveat:
          'Synthetic rows in happy-dom; jsdom is unavailable. No native browser layout, compositor, or physical display paint.',
        rawSamples: samples
      })
    }
    const report = {
      schemaVersion: 1,
      metadata: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        buildMode: 'vitest-happy-dom-react-dom',
        fixtureIdsOnly: true,
        queryTextIncluded: false,
        rawSampleClock: 'renderer-monotonic-performance-now',
        warmRunCount: WARM_REPETITIONS,
        leavesPerWidePage: PAGE_LEAVES,
        committedVirtualRows: COMMITTED_VIRTUAL_ROWS,
        projectionByteBudget: PROJECTION_BYTE_BUDGET
      },
      cases: reports
    }
    await mkdir(join(process.cwd(), 'docs', 'perf'), { recursive: true })
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    expect(reports).toHaveLength(4)
  }, 120_000)
})

function createProjectionCases(): ProjectionCase[] {
  const shallowPaths = Array.from(
    { length: PAGE_LEAVES },
    (_, index) => `file-${index.toString().padStart(5, '0')}-match.ts`
  )
  const deepPaths = Array.from(
    { length: PAGE_LEAVES },
    (_, index) =>
      `src/ancestor-${index % 50}/branch-${index % 250}/feature-${index.toString().padStart(5, '0')}/nested/deeper/match-${index}.tsx`
  )
  const byteLimitedPaths = createByteLimitedPage()
  const deepChainPrefix = Array.from({ length: 64 }, (_, index) => `shared-${index}`).join('/')
  const deepChainPaths = Array.from(
    { length: PAGE_LEAVES },
    (_, index) => `${deepChainPrefix}/leaf-${index.toString().padStart(5, '0')}-match.ts`
  )
  return [
    { fixtureId: 'shallow-5000-leaves', paths: shallowPaths, requestedPageBytes: null },
    {
      fixtureId: 'ancestor-heavy-deep-5000-leaves',
      paths: deepPaths,
      requestedPageBytes: null
    },
    {
      fixtureId: 'byte-limited-page',
      paths: byteLimitedPaths,
      requestedPageBytes: PROJECTION_BYTE_BUDGET
    },
    {
      fixtureId: 'deep-chain-shared-prefix-5000-leaves',
      paths: deepChainPaths,
      requestedPageBytes: null
    }
  ]
}

function createByteLimitedPage(): string[] {
  const paths: string[] = []
  let serializedBytes = 2
  for (let index = 0; index < PAGE_LEAVES; index += 1) {
    const path = `byte-budget-${index.toString().padStart(5, '0')}/${'segment'.repeat(220)}/match-${index}.ts`
    const pathBytes = workspacePathCatalogJsonStringByteLength(path)
    const nextBytes = serializedBytes + pathBytes + (paths.length > 0 ? 1 : 0)
    if (nextBytes > PROJECTION_BYTE_BUDGET) {
      break
    }
    serializedBytes = nextBytes
    paths.push(path)
  }
  return paths
}

async function measureProjection(testCase: ProjectionCase, sample: number): Promise<TimingSample> {
  const correlationId = `projection-matrix-${testCase.fixtureId}-${sample}`
  const nameFilter = {
    query: 'match',
    relativePaths: testCase.paths,
    workspacePathSearch: createStructuredPathPage(testCase.paths)
  }
  const projectionStartedAt = performance.now()
  const projection = createNameFilteredFileExplorerProjection({
    ignoredSet: new Set(),
    nameFilter,
    showDotfiles: true,
    showGitIgnoredFiles: true,
    worktreePath: `/projection-matrix/${sample}`
  })
  const synchronousProjectionMilliseconds = performance.now() - projectionStartedAt

  let projectionChunkCount = 0
  let maxProjectionChunkMilliseconds = 0
  const projectionChunkDurations: number[] = []
  const chunkedProjectionStartedAt = performance.now()
  const chunkedProjection = await createNameFilteredFileExplorerProjectionInChunks({
    ignoredSet: new Set(),
    nameFilter,
    showDotfiles: true,
    showGitIgnoredFiles: true,
    worktreePath: `/projection-matrix-chunked/${sample}`,
    signal: new AbortController().signal,
    onChunkDuration: (milliseconds) => {
      projectionChunkCount += 1
      projectionChunkDurations.push(milliseconds)
      maxProjectionChunkMilliseconds = Math.max(maxProjectionChunkMilliseconds, milliseconds)
      recordRendererPathSearchProjectionChunk(correlationId, milliseconds)
    }
  })
  const projectionMilliseconds = performance.now() - chunkedProjectionStartedAt
  recordRendererPathSearchDuration(correlationId, 'projection', projectionMilliseconds)
  markRendererPathSearchProjectionReady(correlationId)
  expect(getProjectionRows(chunkedProjection)).toEqual(getProjectionRows(projection))
  expect(maxProjectionChunkMilliseconds).toBeLessThan(16)

  const container = document.createElement('div')
  const root = createRoot(container)
  const visibleCount = chunkedProjection.getVisibleCount()
  const visibleRows = chunkedProjection.getVisibleSlice(
    0,
    Math.min(COMMITTED_VIRTUAL_ROWS, visibleCount) - 1
  )
  const commitStartedAt = performance.now()
  await act(async () => {
    root.render(
      createElement(
        'div',
        null,
        visibleRows.map((row) => createElement('div', { key: row.path }, row.name))
      )
    )
  })
  const commitMilliseconds = performance.now() - commitStartedAt
  recordRendererPathSearchCommit(correlationId)
  await waitForTwoAnimationFrames()
  const timings = await window.__orcaWorkspacePathSearchTimings?.()
  const paintTiming = timings?.find(
    (entry) => entry.correlationId === correlationId && entry.stage === 'query-tagged-paint'
  )
  await act(async () => root.unmount())
  return {
    projectionMilliseconds,
    synchronousProjectionMilliseconds,
    projectionChunkCount,
    maxProjectionChunkMilliseconds,
    projectionChunkDurations,
    commitMilliseconds,
    domTwoFrameMilliseconds: paintTiming?.duration.milliseconds ?? null,
    estimatedProjectionBytes: getFileExplorerNameFilterProjectionEstimatedBytes(projection),
    projectedRowCount: visibleCount,
    committedRowCount: visibleRows.length
  }
}

async function waitForTwoAnimationFrames(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function createStructuredPathPage(paths: readonly string[]): WorkspacePathSearchResponse {
  const scope = {
    pathSet: 'all' as const,
    includeDotfiles: true,
    includeIgnoredFiles: true,
    excludePathSegments: []
  }
  const flags: WorkspacePathSearchRowClassificationFlags[] = paths.map(() => 0)
  return {
    requestIdentity: {
      query: 'match',
      consumer: { consumerId: 'projection-matrix', sequence: 1 },
      owner: {
        executionHost: { provider: 'local', incarnationId: 'projection-matrix' },
        authorizedCanonicalRoot: '/projection-matrix'
      },
      generationId: null,
      mode: 'name-filter',
      scope,
      pageBudget: { maxPaths: 5_000, maxSerializedBytes: 16 * 1024 * 1024 }
    },
    generationId: 'projection-matrix-generation',
    scopeFingerprint: JSON.stringify(scope),
    scopeRuleVersion: 'live-path-search-v1',
    rows: paths.map((relativePath) => ({ relativePath })),
    rowClassificationFlags: flags,
    retainedCount: paths.length,
    state: {
      coverage: 'complete',
      freshness: 'no-known-gap',
      countProvenance: 'exact-snapshot',
      searchComplete: true
    },
    count: { value: paths.length, provenance: 'exact-snapshot' }
  }
}

function getProjectionRows(
  projection: ReturnType<typeof createNameFilteredFileExplorerProjection>
) {
  return projection.getVisibleSlice(0, projection.getVisibleCount() - 1).map((row) => ({
    relativePath: row.relativePath,
    name: row.name,
    depth: row.depth,
    isDirectory: row.isDirectory
  }))
}

function summarize(sortedSamples: readonly number[]): {
  p50Milliseconds: number
  p95Milliseconds: number
  maxMilliseconds: number
} {
  return {
    p50Milliseconds: percentile(sortedSamples, 0.5),
    p95Milliseconds: percentile(sortedSamples, 0.95),
    maxMilliseconds: sortedSamples.at(-1) ?? 0
  }
}

function percentile(sortedSamples: readonly number[], percentileValue: number): number {
  return sortedSamples[Math.max(0, Math.ceil(sortedSamples.length * percentileValue) - 1)] ?? 0
}
