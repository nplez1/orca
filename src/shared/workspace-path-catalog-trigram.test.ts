import { describe, expect, it } from 'vitest'
import { generateWorkspacePathCatalog } from './__fixtures__/workspace-path-catalog'
import { WORKSPACE_PATH_SEARCH_QUERY_BATTERY } from './__fixtures__/workspace-path-search-query-battery'
import { WorkspacePathCatalogBuilder } from './workspace-path-catalog-builder'
import { WorkspacePathCatalogOverlayBuilder } from './workspace-path-catalog-overlay'
import {
  assertWorkspacePathSearchEquivalent,
  runWorkspacePathSearchOracle
} from './__fixtures__/workspace-path-search-oracle'
import type { WorkspacePathCatalog, WorkspacePathCatalogGeneration } from './workspace-path-catalog'
import { queryWorkspacePathCatalog } from './workspace-path-catalog-query'
import type { WorkspacePathSearchFenceIdentity } from './workspace-path-search-contract'
import type { WorkspacePathSearchInstrumentationEvent } from './workspace-path-search-instrumentation'

const owner: WorkspacePathSearchFenceIdentity['owner'] = {
  executionHost: { provider: 'local', incarnationId: 'trigram-test' },
  authorizedCanonicalRoot: '/fixture'
}

describe('workspace path catalog trigram postings', () => {
  it('verifies trigram false positives with the exact substring predicate', async () => {
    const snapshot = ['src/abcd.ts', 'src/abcXbcd.ts', 'src/abce.ts']
    const catalog = buildCatalog(snapshot, 1024 * 1024)
    expect(catalog.trigramPostings).toBeDefined()
    const result = await query(catalog, 'abcd')

    expect(result.rows.map((row) => row.relativePath)).toEqual(['src/abcd.ts'])
    expect(result.count).toEqual({ value: 1, provenance: 'exact-snapshot' })
  })

  it('treats absent, unbuilt, and over-budget postings as scan fallback or certified zero', async () => {
    const snapshot = ['src/alpha.ts', 'src/beta.ts']
    const catalog = buildCatalog(snapshot, 1024 * 1024)
    const indexedEvents: WorkspacePathSearchInstrumentationEvent[] = []
    const absent = await query(catalog, 'qzx', indexedEvents)
    expect(absent.count).toEqual({ value: 0, provenance: 'exact-snapshot' })
    expect(indexedEvents).toContainEqual(
      expect.objectContaining({
        kind: 'query-metrics',
        record: expect.objectContaining({ strategy: 'trigram-postings', pathsConsidered: 0 })
      })
    )

    const noAccelerator = { ...catalog, trigramPostings: undefined }
    const fallbackEvents: WorkspacePathSearchInstrumentationEvent[] = []
    const fallback = await query(noAccelerator, 'qzx', fallbackEvents)
    expect(fallback.count).toEqual({ value: 0, provenance: 'exact-snapshot' })
    expect(fallbackEvents).toContainEqual(
      expect.objectContaining({
        kind: 'query-metrics',
        record: expect.objectContaining({ strategy: 'ordered-scan', pathsConsidered: 2 })
      })
    )

    const constrained = buildCatalog(snapshot, 2_048)
    expect(constrained).toBeDefined()
    expect(constrained?.trigramPostings).toBeUndefined()
    if (!constrained) {
      throw new Error('Catalog should remain available without postings')
    }
    expect((await query(constrained, 'alpha')).count).toEqual({
      value: 1,
      provenance: 'exact-snapshot'
    })
  })

  it('falls back to ordered scanning for broad repeated trigrams', async () => {
    const snapshot = Array.from({ length: 2_000 }, (_, index) => `src/aaaaa-${index}.ts`)
    const catalog = buildCatalog(snapshot, 2 * 1024 * 1024)
    const events: WorkspacePathSearchInstrumentationEvent[] = []

    const result = await query(catalog, 'aaa', events)
    expect(result.count).toEqual({ value: snapshot.length, provenance: 'exact-snapshot' })
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'query-metrics',
        record: expect.objectContaining({ strategy: 'ordered-scan', pathsConsidered: 2_000 })
      })
    )
  })

  it('uses long-token postings to check short tokens, and scans for short-only queries', async () => {
    const snapshot = [
      'src/ab-needle.ts',
      'src/xy-needle.ts',
      'src/ab-other.ts',
      'src/other-1.ts',
      'src/other-2.ts',
      'src/other-3.ts',
      'src/other-4.ts',
      'src/other-5.ts'
    ]
    const catalog = buildCatalog(snapshot, 1024 * 1024)
    const longAndShortEvents: WorkspacePathSearchInstrumentationEvent[] = []

    expect((await query(catalog, 'ab needle', longAndShortEvents)).rows).toEqual([
      { relativePath: 'src/ab-needle.ts' }
    ])
    expect(longAndShortEvents).toContainEqual(
      expect.objectContaining({
        kind: 'query-metrics',
        record: expect.objectContaining({ strategy: 'trigram-postings', pathsConsidered: 2 })
      })
    )

    const shortOnlyEvents: WorkspacePathSearchInstrumentationEvent[] = []
    expect((await query(catalog, 'ab', shortOnlyEvents)).count).toEqual({
      value: 2,
      provenance: 'exact-snapshot'
    })
    expect(shortOnlyEvents).toContainEqual(
      expect.objectContaining({
        kind: 'query-metrics',
        record: expect.objectContaining({ strategy: 'ordered-scan', pathsConsidered: 8 })
      })
    )
  })

  it('keeps exact counts and natural-order pages beyond the retained page', async () => {
    const snapshot = [
      ...Array.from({ length: 5_000 }, (_, index) => `src/unrelated-${index}.ts`),
      ...Array.from(
        { length: 5_102 },
        (_, index) => `src/match-${index.toString().padStart(5, '0')}-needle.ts`
      )
    ]
    const catalog = buildCatalog(snapshot, 8 * 1024 * 1024)
    const result = await query(catalog, 'needle', undefined, 12)
    const expected = runWorkspacePathSearchOracle(snapshot, 'needle', {
      pageBudget: { maxPaths: 12, maxSerializedBytes: 1_000_000 }
    })
    assertWorkspacePathSearchEquivalent('needle', expected, {
      paths: result.rows.map((row) => row.relativePath),
      totalCount: result.count.value ?? -1
    })
    expect(result.rows).toHaveLength(12)
    expect(result.count).toEqual({ value: 5_102, provenance: 'exact-snapshot' })
  })

  it('scans delta entries while suppressing deleted and replaced base paths', async () => {
    const snapshot = ['src/deleted-target.ts', 'src/replaced-target.ts', 'src/kept-target.ts']
    const catalog = buildCatalog(snapshot, 1024 * 1024)
    const pathIds = new Map(snapshot.map((path, index) => [path, index]))
    const overlayBuilder = new WorkspacePathCatalogOverlayBuilder(catalog, {
      generationId: 'trigram-delta-1',
      maxBytes: 1024 * 1024,
      findBasePathId: (path) => pathIds.get(path)
    })
    expect(overlayBuilder.deletePath('src/deleted-target.ts')).toBe(true)
    expect(overlayBuilder.upsertPath('src/replaced-target.ts', 0)).toBe(true)
    expect(overlayBuilder.addPath('src/kept-target.ts', 'all')).toBe(true)
    expect(overlayBuilder.addPath('src/delta-target.ts', 'all')).toBe(true)
    const overlay = overlayBuilder.finish()
    expect(overlay).not.toBeNull()
    if (!overlay) {
      throw new Error('Expected the overlay to publish')
    }

    const result = await query({ catalog, overlay }, 'target')
    expect(result.rows.map((row) => row.relativePath)).toEqual([
      'src/delta-target.ts',
      'src/kept-target.ts'
    ])
    expect(result.count).toEqual({ value: 2, provenance: 'exact-snapshot' })
  })

  it('matches the query battery across scope descriptors and both generated profiles', async () => {
    const ignoredPath = 'ignored/target-only.ts'
    const excludedPath = 'packages/app/src/excluded-target.ts'
    const scopeCases = [
      {
        scope: {
          pathSet: 'all' as const,
          includeDotfiles: true,
          includeIgnoredFiles: true,
          excludePathSegments: []
        },
        includeDotfiles: true,
        includeIgnoredFiles: true,
        excludePaths: []
      },
      {
        scope: {
          pathSet: 'all' as const,
          includeDotfiles: false,
          includeIgnoredFiles: true,
          excludePathSegments: []
        },
        includeDotfiles: false,
        includeIgnoredFiles: true,
        excludePaths: []
      },
      {
        scope: {
          pathSet: 'all' as const,
          includeDotfiles: true,
          includeIgnoredFiles: false,
          excludePathSegments: []
        },
        includeDotfiles: true,
        includeIgnoredFiles: false,
        excludePaths: []
      },
      {
        scope: {
          pathSet: 'included' as const,
          includeDotfiles: false,
          includeIgnoredFiles: false,
          excludePathSegments: [['packages', 'app']]
        },
        includeDotfiles: false,
        includeIgnoredFiles: false,
        excludePaths: ['/fixture/packages/app']
      }
    ] as const
    for (const shape of ['realistic-shared-prefixes', 'adversarial-long-unshared'] as const) {
      const snapshot = [
        ...new Set([
          ...generateWorkspacePathCatalog({ size: 512, shape, seed: 0x6a71 }),
          ignoredPath,
          excludedPath
        ])
      ]
      const includedPaths = new Set(snapshot.filter((path) => path !== ignoredPath))
      const catalog = buildCatalog(snapshot, 8 * 1024 * 1024, includedPaths)
      for (const descriptor of scopeCases) {
        for (const testCase of WORKSPACE_PATH_SEARCH_QUERY_BATTERY) {
          const expected = runWorkspacePathSearchOracle(snapshot, testCase.query, {
            scope: {
              rootPath: '/fixture',
              includeDotfiles: descriptor.includeDotfiles,
              includeIgnoredFiles: descriptor.includeIgnoredFiles,
              excludePaths: descriptor.excludePaths,
              ignoredPaths: new Set([ignoredPath])
            },
            pageBudget: { maxPaths: 31, maxSerializedBytes: 50_000 }
          })
          const actual = await query(catalog, testCase.query, undefined, 31, descriptor.scope)
          try {
            assertWorkspacePathSearchEquivalent(testCase.query, expected, {
              paths: actual.rows.map((row) => row.relativePath),
              totalCount: actual.count.value ?? -1
            })
          } catch (error) {
            throw new Error(`${shape}/${JSON.stringify(descriptor.scope)}: ${String(error)}`)
          }
        }
      }
    }
  })

  it('matches randomized queries against the complete oracle', async () => {
    let seed = 0x51a7
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff
      return seed
    }
    const snapshot = Array.from(
      { length: 1_200 },
      (_, index) =>
        `scope-${index % 9}/group-${random() % 41}/item-${random().toString(36)}-${index}.ts`
    )
    const catalog = buildCatalog(snapshot, 8 * 1024 * 1024)
    const tokens = ['scope', 'group', 'item', 'ts', 'missing', '00', 'item-1', 'scope-4']
    for (let sample = 0; sample < 120; sample += 1) {
      const queryText = Array.from(
        { length: (random() % 3) + 1 },
        () => tokens[random() % tokens.length] ?? 'item'
      ).join(' ')
      const expected = runWorkspacePathSearchOracle(snapshot, queryText, {
        pageBudget: { maxPaths: 37, maxSerializedBytes: 100_000 }
      })
      const actual = await query(catalog, queryText, undefined, 37)
      assertWorkspacePathSearchEquivalent(queryText, expected, {
        paths: actual.rows.map((row) => row.relativePath),
        totalCount: actual.count.value ?? -1
      })
    }
  })
})

function buildCatalog(
  paths: readonly string[],
  maxBytes: number,
  includedPaths: ReadonlySet<string> = new Set(paths)
) {
  const builder = new WorkspacePathCatalogBuilder({
    generationId: 'trigram-generation',
    maxBytes,
    storage: 'packed-folded',
    freshness: 'no-known-gap'
  })
  for (const path of paths) {
    if (!builder.addPath(path, 'all')) {
      throw new Error(`Could not add catalog path ${path}`)
    }
    if (includedPaths.has(path) && !builder.addPath(path, 'included')) {
      throw new Error(`Could not add included catalog path ${path}`)
    }
  }
  builder.markScopeComplete('included')
  builder.markScopeComplete('all')
  builder.completeClassification()
  const catalog = builder.finish()
  if (!catalog) {
    throw new Error('Catalog failed to publish')
  }
  return catalog
}

async function query(
  catalog: WorkspacePathCatalog | WorkspacePathCatalogGeneration,
  queryText: string,
  events?: WorkspacePathSearchInstrumentationEvent[],
  maxPaths = 100,
  scope: WorkspacePathSearchFenceIdentity['scope'] = {
    pathSet: 'all',
    includeDotfiles: true,
    includeIgnoredFiles: true,
    excludePathSegments: []
  }
) {
  const identity: WorkspacePathSearchFenceIdentity = {
    query: queryText,
    consumer: { consumerId: 'trigram-test', sequence: 1 },
    owner,
    generationId: null,
    mode: 'name-filter',
    scope,
    pageBudget: { maxPaths, maxSerializedBytes: 1_000_000 }
  }
  return queryWorkspacePathCatalog(catalog, {
    identity,
    ...(events ? { onInstrumentation: (event) => events.push(event) } : {}),
    yieldToWorker: async () => undefined
  })
}
