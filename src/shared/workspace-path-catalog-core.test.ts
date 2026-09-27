import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_PATH_SEARCH_ROW_FLAGS,
  type WorkspacePathSearchFenceIdentity,
  type WorkspacePathSearchScopeDescriptor
} from './workspace-path-search-contract'
import type { WorkspacePathSearchInstrumentationEvent } from './workspace-path-search-instrumentation'
import {
  getWorkspacePathCatalogOriginalPath,
  type WorkspacePathCatalog
} from './workspace-path-catalog'
import { WorkspacePathCatalogBuilder } from './workspace-path-catalog-builder'
import {
  queryWorkspacePathCatalog,
  workspacePathCatalogJsonStringByteLength,
  WorkspacePathCatalogFoldVersionError,
  WorkspacePathCatalogGenerationUnavailableError
} from './workspace-path-catalog-query'
import {
  generatePathMatchCardinalityCatalog,
  generateWorkspacePathCatalog,
  WORKSPACE_PATH_CATALOG_EDGE_PATHS
} from './__fixtures__/workspace-path-catalog'
import {
  assertWorkspacePathSearchEquivalent,
  runWorkspacePathSearchOracle,
  type WorkspacePathSearchOracleOptions
} from './__fixtures__/workspace-path-search-oracle'
import { WORKSPACE_PATH_SEARCH_QUERY_BATTERY } from './__fixtures__/workspace-path-search-query-battery'

const TEST_MEMORY_BUDGET = 512 * 1024 * 1024
const TEST_IGNORED_PATHS = new Set(['ignored/reports/target-ignored.ts'])
const RUN_PATH_SEARCH_SCALE = process.env.ORCA_RUN_PATH_SEARCH_SCALE === '1'

describe('workspace path catalog core', () => {
  it('keeps original and folded offset domains independent for Unicode paths', () => {
    const catalog = buildCatalog([...WORKSPACE_PATH_CATALOG_EDGE_PATHS], 'folded-strings')
    const istanbulId = findPathId(catalog, 'src/shared/İstanbul/data.ts')
    const combiningId = findPathId(catalog, 'src/unicode/cafe\u0301.ts')
    const supplementaryId = findPathId(catalog, 'src/unicode/𐐀-module/index.ts')

    expect(istanbulId).toBeDefined()
    expect(combiningId).toBeDefined()
    expect(supplementaryId).toBeDefined()
    const dottedIId = requirePathId(istanbulId)
    const decomposedId = requirePathId(combiningId)
    const supplementaryPathId = requirePathId(supplementaryId)
    expect(foldedLength(catalog, dottedIId)).toBe(
      'src/shared/İstanbul/data.ts'.toLocaleLowerCase().length
    )
    expect(foldedLength(catalog, dottedIId)).toBeGreaterThan('src/shared/İstanbul/data.ts'.length)
    expect(foldedLength(catalog, decomposedId)).toBe('src/unicode/cafe\u0301.ts'.length)
    expect(foldedLength(catalog, supplementaryPathId)).toBe('src/unicode/𐐀-module/index.ts'.length)
    const originalStart = catalog.originalOffsets[dottedIId]
    const originalEnd = catalog.originalOffsets[dottedIId + 1]
    if (originalStart === undefined || originalEnd === undefined) {
      throw new Error('Expected original path offsets')
    }
    expect(originalEnd - originalStart).toBe(
      new TextEncoder().encode('src/shared/İstanbul/data.ts').length
    )
    expect(getWorkspacePathCatalogOriginalPath(catalog, dottedIId)).toBe(
      'src/shared/İstanbul/data.ts'
    )
  })

  it('keeps packed folded offsets correct across length-changing Unicode folds', () => {
    const catalog = buildCatalog([...WORKSPACE_PATH_CATALOG_EDGE_PATHS], 'packed-folded')
    const istanbulId = findPathId(catalog, 'src/shared/İstanbul/data.ts')
    const supplementaryId = findPathId(catalog, 'src/unicode/𐐀-module/index.ts')
    expect(catalog.storageKind).toBe('packed-folded')
    expect(foldedLength(catalog, requirePathId(istanbulId))).toBe(
      'src/shared/İstanbul/data.ts'.toLocaleLowerCase().length
    )
    expect(foldedLength(catalog, requirePathId(supplementaryId))).toBe(
      'src/unicode/𐐀-module/index.ts'.length
    )
    if (catalog.storageKind === 'packed-folded') {
      expect(catalog.foldedCodeUnits.length).toBe(catalog.foldedOffsets[catalog.pathCount])
    }
  })

  it('prefix-compresses original and folded paths without changing Unicode query results', async () => {
    const paths = [...WORKSPACE_PATH_CATALOG_EDGE_PATHS]
    const catalog = buildCatalog(paths, 'prefix-compressed')
    const packedCatalog = buildCatalog(paths, 'packed-folded')
    expect(catalog.storageKind).toBe('prefix-compressed')
    if (
      catalog.storageKind !== 'prefix-compressed' ||
      packedCatalog.storageKind !== 'packed-folded'
    ) {
      throw new Error('Expected both packed catalog layouts')
    }
    expect(catalog.originalBlockData.byteLength + catalog.foldedBlockData.byteLength).toBeLessThan(
      packedCatalog.originalUtf8.byteLength + packedCatalog.foldedCodeUnits.byteLength
    )
    for (let pathId = 0; pathId < catalog.pathCount; pathId += 1) {
      const path = getWorkspacePathCatalogOriginalPath(catalog, pathId)
      expect(findPathId(catalog, path)).toBe(pathId)
    }
    for (const query of ['İstanbul', 'ısparta', 'cafe\u0301', '𐐨', 'target', 'src/shared']) {
      const expected = runWorkspacePathSearchOracle(
        paths,
        query,
        oracleOptions(createScope('all', true, true, false))
      )
      const response = await queryWorkspacePathCatalog(catalog, {
        identity: createIdentity(query, createScope('all', true, true, false))
      })
      assertWorkspacePathSearchEquivalent(query, expected, {
        paths: response.rows.map((row) => row.relativePath),
        totalCount: response.count.value ?? -1
      })
    }
  })

  it('rejects a damaged prefix-compressed block before returning query results', async () => {
    const catalog = buildCatalog([...WORKSPACE_PATH_CATALOG_EDGE_PATHS], 'prefix-compressed')
    if (catalog.storageKind !== 'prefix-compressed') {
      throw new Error('Expected prefix-compressed catalog')
    }
    catalog.foldedBlockData[0] = (catalog.foldedBlockData[0] ?? 0) ^ 0xff
    await expect(
      queryWorkspacePathCatalog(catalog, {
        identity: createIdentity('a', createScope('all', true, true, false))
      })
    ).rejects.toThrow('checksum mismatch')
  })

  it('matches Unicode query tokens against the packed folded block layout', async () => {
    const paths = [...WORKSPACE_PATH_CATALOG_EDGE_PATHS]
    const catalog = buildCatalog(paths, 'packed-folded')
    for (const query of ['İstanbul', 'ısparta', 'cafe\u0301', '𐐨']) {
      const expected = runWorkspacePathSearchOracle(
        paths,
        query,
        oracleOptions(createScope('all', true, true, false))
      )
      const response = await queryWorkspacePathCatalog(catalog, {
        identity: createIdentity(query, createScope('all', true, true, false))
      })
      assertWorkspacePathSearchEquivalent(query, expected, {
        paths: response.rows.map((row) => row.relativePath),
        totalCount: response.count.value ?? -1
      })
    }
  })

  it('matches every query and scope for both generated profiles in prefix blocks', async () => {
    for (const profile of ['realistic-shared-prefixes', 'adversarial-long-unshared'] as const) {
      const paths = [...generateWorkspacePathCatalog({ size: 500, profile, seed: 0x50455246 })]
      const catalog = buildCatalog(paths, 'prefix-compressed')
      for (const scope of allScopeDescriptors()) {
        const options = oracleOptions(scope)
        const oraclePaths =
          scope.pathSet === 'included'
            ? paths.filter((path) => !TEST_IGNORED_PATHS.has(path))
            : paths
        for (const { query } of WORKSPACE_PATH_SEARCH_QUERY_BATTERY) {
          const expected = runWorkspacePathSearchOracle(oraclePaths, query, options)
          const actual = await queryWorkspacePathCatalog(catalog, {
            identity: createIdentity(query, scope)
          })
          assertWorkspacePathSearchEquivalent(query, expected, {
            paths: actual.rows.map((row) => row.relativePath),
            totalCount: actual.count.value ?? -1
          })
        }
      }
    }
  })

  it('matches the full oracle battery and every scope descriptor at 100k paths', async () => {
    await assertGeneratedCatalogParity(100_000)
  }, 300_000)

  it('matches the full battery and every scope descriptor at 300k paths', async () => {
    await assertGeneratedCatalogParity(300_000)
  }, 600_000)

  it('aligns ignore-classification and dotfile flags with retained rows', async () => {
    const paths = [...WORKSPACE_PATH_CATALOG_EDGE_PATHS]
    const catalog = buildCatalog(paths, 'folded-strings')
    const response = await queryWorkspacePathCatalog(catalog, {
      identity: createIdentity('target', createScope('all', true, true, false))
    })
    expect(response.rowClassificationFlags).toHaveLength(response.rows.length)
    const hiddenIndex = response.rows.findIndex(
      (row) => row.relativePath === 'src/.generated/target-hidden.ts'
    )
    const ignoredIndex = response.rows.findIndex(
      (row) => row.relativePath === 'ignored/reports/target-ignored.ts'
    )
    expect(response.rowClassificationFlags[hiddenIndex]).toBe(
      WORKSPACE_PATH_SEARCH_ROW_FLAGS.dotfile |
        WORKSPACE_PATH_SEARCH_ROW_FLAGS.ignoreClassificationKnown
    )
    expect(response.rowClassificationFlags[ignoredIndex]).toBe(
      WORKSPACE_PATH_SEARCH_ROW_FLAGS.ignored |
        WORKSPACE_PATH_SEARCH_ROW_FLAGS.ignoreClassificationKnown
    )
  })

  it('preserves exact cardinalities around the retained-page ceiling', async () => {
    const scope = createScope('all', true, true, false)
    for (const matchCount of [0, 1, 5_000, 5_001, 5_100]) {
      const paths = [...generatePathMatchCardinalityCatalog(matchCount, 2)]
      const catalog = buildCatalog(paths, 'folded-strings')
      const expected = runWorkspacePathSearchOracle(
        paths,
        'cardinality match',
        oracleOptions(scope)
      )
      const actual = await queryWorkspacePathCatalog(catalog, {
        identity: createIdentity('cardinality match', scope)
      })
      assertWorkspacePathSearchEquivalent('cardinality match', expected, {
        paths: actual.rows.map((row) => row.relativePath),
        totalCount: actual.count.value ?? -1
      })
      expect(actual.retainedCount).toBe(Math.min(matchCount, 5_000))
      const noRetention = await queryWorkspacePathCatalog(catalog, {
        identity: createIdentity('cardinality match', scope, {
          maxPaths: 0,
          maxSerializedBytes: Number.POSITIVE_INFINITY
        })
      })
      expect(noRetention.retainedCount).toBe(0)
      expect(noRetention.count.value).toBe(matchCount)
    }
  })

  it('counts JSON-escaped UTF-8 bytes exactly, including surrogate edge cases', () => {
    for (const value of ['plain', 'a/"b"', 'line\ncontrol\u0001', 'café-𐐀', 'lone-\ud800']) {
      expect(workspacePathCatalogJsonStringByteLength(value)).toBe(
        new TextEncoder().encode(JSON.stringify(value)).length
      )
    }
  })

  it('counts past byte-limited retention and matches escaped JSON page accounting', async () => {
    const paths = [
      ...generateWorkspacePathCatalog({ size: 96, profile: 'realistic-shared-prefixes' }),
      'src/long-budget/"quoted-segment-0-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"-target.ts',
      'src/long-budget/"quoted-segment-1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"-target.ts'
    ]
    const catalog = buildCatalog(paths, 'folded-strings')
    const scope = createScope('all', true, true, false)
    const query = 'budget target'
    const complete = runWorkspacePathSearchOracle(paths, query, oracleOptions(scope))
    const firstPath = complete.paths[0]
    if (firstPath === undefined) {
      throw new Error('Expected a matching escaped path')
    }
    const budget =
      new TextEncoder().encode(JSON.stringify({ paths: [], totalCount: complete.totalCount }))
        .length + new TextEncoder().encode(JSON.stringify(firstPath)).length
    const expected = runWorkspacePathSearchOracle(paths, query, {
      ...oracleOptions(scope),
      pageBudget: { maxPaths: 5_000, maxSerializedBytes: budget }
    })
    const actual = await queryWorkspacePathCatalog(catalog, {
      identity: createIdentity(query, scope, { maxPaths: 5_000, maxSerializedBytes: budget })
    })

    expect(actual.count).toEqual({ value: expected.totalCount, provenance: 'exact-snapshot' })
    expect(actual.rows.map((row) => row.relativePath)).toEqual(expected.paths)
  })

  it('does not claim complete coverage when discovery omitted an unrequested exclusion', async () => {
    const builder = new WorkspacePathCatalogBuilder({
      generationId: 'excluded-coverage',
      maxBytes: TEST_MEMORY_BUDGET,
      freshness: 'no-known-gap',
      coverageExcludePathSegments: [['packages', 'app']]
    })
    builder.addBatch(['src/target.ts', 'packages/app2/target.ts'], 'all')
    builder.markScopeComplete('all')
    const catalog = builder.finish()
    if (!catalog) {
      throw new Error('Expected exclusion-scoped catalog')
    }
    const uncovered = await queryWorkspacePathCatalog(catalog, {
      identity: createIdentity('target', createScope('all', true, true, false))
    })
    expect(uncovered.state.coverage).toBe('partial')
    expect(uncovered.degradationReason).toBe('uncovered-scope')
    expect(uncovered.count).toEqual({ value: null, provenance: 'provisional' })

    const covered = await queryWorkspacePathCatalog(catalog, {
      identity: createIdentity('target', createScope('all', true, true, true))
    })
    expect(covered.state.coverage).toBe('complete')
    expect(covered.rows.map((row) => row.relativePath)).toEqual([
      'packages/app2/target.ts',
      'src/target.ts'
    ])
  })

  it('emits numeric normalization, sort, and publication stage durations', () => {
    const events: WorkspacePathSearchInstrumentationEvent[] = []
    const builder = new WorkspacePathCatalogBuilder({
      generationId: 'instrumented-build',
      maxBytes: TEST_MEMORY_BUDGET,
      freshness: 'no-known-gap',
      onInstrumentation: (event) => events.push(event)
    })
    builder.addPath('src/target.ts', 'all')
    builder.markScopeComplete('all')
    expect(builder.finish()).not.toBeNull()
    const stages = events
      .filter((event) => event.kind === 'stage-timing')
      .map((event) => event.record)
    expect(stages.map((event) => event.stage)).toEqual([
      'normalization',
      'sort',
      'index-publication'
    ])
    expect(stages.every((event) => Number.isFinite(event.duration.milliseconds))).toBe(true)
  })

  it('rejects a request pinned to a different generation', async () => {
    const catalog = buildCatalog(['src/target.ts'], 'folded-strings')
    const identity = {
      ...createIdentity('target', createScope('all', true, true, false)),
      generationId: 'expired-generation'
    }
    await expect(queryWorkspacePathCatalog(catalog, { identity })).rejects.toBeInstanceOf(
      WorkspacePathCatalogGenerationUnavailableError
    )
  })

  it('invalidates catalogs when the recorded fold locale is stale', async () => {
    const builder = new WorkspacePathCatalogBuilder({
      generationId: 'stale-fold',
      maxBytes: TEST_MEMORY_BUDGET,
      foldLocale: 'tr'
    })
    builder.addPath('src/İstanbul.ts', 'all')
    builder.markScopeComplete('all')
    const catalog = builder.finish()
    expect(catalog).not.toBeNull()
    if (!catalog) {
      throw new Error('Expected catalog')
    }
    if (catalog.metadata.foldLocale !== Intl.DateTimeFormat().resolvedOptions().locale) {
      await expect(
        queryWorkspacePathCatalog(catalog, {
          identity: createIdentity('istanbul', createScope('all', true, true, false))
        })
      ).rejects.toBeInstanceOf(WorkspacePathCatalogFoldVersionError)
    }
  })
})

describe.skipIf(!RUN_PATH_SEARCH_SCALE)('workspace path catalog opt-in scale parity', () => {
  it.each([500_000, 1_000_000])(
    'matches the query battery and scope matrix at %i paths',
    async (size) => {
      await assertGeneratedCatalogParity(size, 2 * 1024 * 1024 * 1024)
    },
    1_500_000
  )
})

async function assertGeneratedCatalogParity(
  size: number,
  maxBytes = TEST_MEMORY_BUDGET
): Promise<void> {
  const paths = [
    ...generateWorkspacePathCatalog({
      size,
      profile: 'realistic-shared-prefixes',
      seed: 0x50455246
    })
  ]
  const catalog = buildCatalog(paths, 'folded-strings', maxBytes)
  const scopeCases = allScopeDescriptors()

  for (const scope of scopeCases) {
    const options = oracleOptions(scope)
    const oraclePaths =
      scope.pathSet === 'included' ? paths.filter((path) => !TEST_IGNORED_PATHS.has(path)) : paths
    for (const { query } of WORKSPACE_PATH_SEARCH_QUERY_BATTERY) {
      const expected = runWorkspacePathSearchOracle(oraclePaths, query, options)
      const actual = await queryWorkspacePathCatalog(catalog, {
        identity: createIdentity(query, scope)
      })
      assertWorkspacePathSearchEquivalent(query, expected, {
        paths: actual.rows.map((row) => row.relativePath),
        totalCount: actual.count.value ?? -1
      })
      expect(actual.count.provenance).toBe('exact-snapshot')
    }
  }
}

function buildCatalog(
  paths: readonly string[],
  storage: 'folded-strings' | 'packed-folded' | 'prefix-compressed',
  maxBytes = TEST_MEMORY_BUDGET
): WorkspacePathCatalog {
  const builder = new WorkspacePathCatalogBuilder({
    generationId: `catalog-${paths.length}-${storage}`,
    maxBytes,
    storage,
    freshness: 'no-known-gap'
  })
  builder.addBatch(paths, 'all')
  builder.addBatch(
    paths.filter((path) => !TEST_IGNORED_PATHS.has(path)),
    'included'
  )
  builder.markScopeComplete('included')
  builder.markScopeComplete('all')
  builder.completeClassification()
  const catalog = builder.finish()
  if (!catalog) {
    throw new Error('Test catalog exceeded its admission budget')
  }
  return catalog
}

function allScopeDescriptors(): WorkspacePathSearchScopeDescriptor[] {
  const scopes: WorkspacePathSearchScopeDescriptor[] = []
  for (const pathSet of ['included', 'all'] as const) {
    for (const includeDotfiles of [false, true]) {
      for (const includeIgnoredFiles of [false, true]) {
        for (const excludes of [false, true]) {
          scopes.push(createScope(pathSet, includeDotfiles, includeIgnoredFiles, excludes))
        }
      }
    }
  }
  return scopes
}

function createScope(
  pathSet: 'included' | 'all',
  includeDotfiles: boolean,
  includeIgnoredFiles: boolean,
  excludes: boolean
): WorkspacePathSearchScopeDescriptor {
  return {
    pathSet,
    includeDotfiles,
    includeIgnoredFiles,
    excludePathSegments: excludes ? [['packages', 'app']] : []
  }
}

function createIdentity(
  query: string,
  scope: WorkspacePathSearchScopeDescriptor,
  pageBudget = { maxPaths: 5_000, maxSerializedBytes: Number.POSITIVE_INFINITY }
): WorkspacePathSearchFenceIdentity {
  return {
    query,
    consumer: { consumerId: 'catalog-test', sequence: 1 },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'test-host' },
      authorizedCanonicalRoot: '/fixture'
    },
    generationId: null,
    mode: 'name-filter',
    scope,
    pageBudget
  }
}

function oracleOptions(
  scope: WorkspacePathSearchScopeDescriptor
): WorkspacePathSearchOracleOptions {
  return {
    scope: {
      rootPath: '/fixture',
      excludePaths: scope.excludePathSegments.map((segments) => `/fixture/${segments.join('/')}`),
      ignoredPaths: TEST_IGNORED_PATHS,
      includeDotfiles: scope.includeDotfiles,
      includeIgnoredFiles: scope.includeIgnoredFiles
    }
  }
}

function findPathId(catalog: WorkspacePathCatalog, path: string): number | undefined {
  for (let id = 0; id < catalog.pathCount; id += 1) {
    if (getWorkspacePathCatalogOriginalPath(catalog, id) === path) {
      return id
    }
  }
  return undefined
}

function requirePathId(pathId: number | undefined): number {
  if (pathId === undefined) {
    throw new Error('Expected path in catalog')
  }
  return pathId
}

function foldedLength(catalog: WorkspacePathCatalog, pathId: number): number {
  return (catalog.foldedOffsets[pathId + 1] ?? 0) - (catalog.foldedOffsets[pathId] ?? 0)
}
