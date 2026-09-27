import { describe, expect, it } from 'vitest'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchScopeDescriptor
} from './workspace-path-search-contract'
import type { WorkspacePathSearchInstrumentationEvent } from './workspace-path-search-instrumentation'
import { WorkspacePathCatalogBuilder } from './workspace-path-catalog-builder'
import { queryWorkspacePathCatalog } from './workspace-path-catalog-query'
import {
  DEFAULT_WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE,
  runWorkspacePathSearchShadowSample,
  WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE_ENV
} from './__fixtures__/workspace-path-search-shadow-harness'

const PATHS = ['src/features/target-a.ts', 'src/target-b.txt', 'target.ts', 'src/other.ts']
const SCOPE: WorkspacePathSearchScopeDescriptor = {
  pathSet: 'all',
  includeDotfiles: true,
  includeIgnoredFiles: true,
  excludePathSegments: []
}
const IDENTITY: WorkspacePathSearchFenceIdentity = {
  query: 'target',
  consumer: { consumerId: 'shadow-test', sequence: 1 },
  owner: {
    executionHost: { provider: 'local', incarnationId: 'shadow-test-host' },
    authorizedCanonicalRoot: '/fixture'
  },
  generationId: null,
  mode: 'name-filter',
  scope: SCOPE,
  pageBudget: { maxPaths: 5_000, maxSerializedBytes: Number.POSITIVE_INFINITY }
}

function buildGeneration() {
  const builder = new WorkspacePathCatalogBuilder({
    generationId: 'shadow-fixture-generation',
    maxBytes: 1024 * 1024,
    storage: 'folded-strings',
    freshness: 'no-known-gap'
  })
  builder.addBatch(PATHS, 'all')
  builder.addBatch(PATHS, 'included')
  builder.markScopeComplete('included')
  builder.markScopeComplete('all')
  builder.completeClassification()
  const generation = builder.finish()
  if (!generation) {
    throw new Error('Shadow fixture catalog exceeded its budget')
  }
  return generation
}

async function queryCatalog(
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
) {
  const result = await queryWorkspacePathCatalog(buildGeneration(), {
    identity: IDENTITY,
    onInstrumentation
  })
  return {
    paths: result.rows.map((row) => row.relativePath),
    totalCount: result.count.value ?? -1
  }
}

describe('workspace path search sampled shadow harness', () => {
  it('compares a sampled index query with the fixture oracle without changing its result', async () => {
    const indexEvents: WorkspacePathSearchInstrumentationEvent[] = []
    const actual = await queryCatalog((event) => indexEvents.push(event))
    const result = await runWorkspacePathSearchShadowSample({
      fixtureId: 'small-path-catalog',
      query: IDENTITY.query,
      snapshot: PATHS,
      oracleOptions: {
        scope: {
          rootPath: '/fixture',
          excludePaths: [],
          ignoredPaths: new Set(),
          includeDotfiles: true,
          includeIgnoredFiles: true
        },
        pageBudget: IDENTITY.pageBudget
      },
      actual: () => actual,
      sampleRate: 1
    })

    expect(result).toEqual({ sampled: true, actual, mismatch: null })
    expect(indexEvents).toContainEqual(
      expect.objectContaining({
        kind: 'query-metrics',
        record: expect.objectContaining({ strategy: 'ordered-scan' })
      })
    )
    expect(actual).toEqual({
      paths: ['src/features/target-a.ts', 'src/target-b.txt', 'target.ts'],
      totalCount: 3
    })
  })

  it('does not run the oracle for an unsampled query', async () => {
    let actualCalls = 0
    const result = await runWorkspacePathSearchShadowSample({
      fixtureId: 'private-workspace',
      query: 'private-name',
      snapshot: ['private-name.ts'],
      actual: () => {
        actualCalls += 1
        return { paths: [], totalCount: 0 }
      },
      sampleRate: 0
    })

    expect(result).toMatchObject({ sampled: false, actual: { paths: [], totalCount: 0 } })
    expect(actualCalls).toBe(1)
  })

  it('reports mismatches with hashed identifiers and numeric counts only', async () => {
    const diagnostics: unknown[] = []
    const result = await runWorkspacePathSearchShadowSample({
      fixtureId: 'private-workspace',
      query: 'private-name',
      snapshot: ['private-name.ts'],
      oracleOptions: {
        scope: {
          rootPath: '/fixture',
          excludePaths: [],
          ignoredPaths: new Set(),
          includeDotfiles: true,
          includeIgnoredFiles: true
        }
      },
      actual: () => ({ paths: [], totalCount: 0 }),
      sampleRate: 1,
      onMismatch: (diagnostic) => diagnostics.push(diagnostic)
    })
    const serialized = JSON.stringify(diagnostics)

    expect(result.actual).toEqual({ paths: [], totalCount: 0 })
    expect(result.mismatch).toMatchObject({
      fixtureIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      queryHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      expectedTotalCount: 1,
      actualTotalCount: 0
    })
    expect(serialized).not.toContain('private-workspace')
    expect(serialized).not.toContain('private-name')
    expect(serialized).not.toContain('private-name.ts')
  })

  it('defaults to low sampling and honors the configurable dev/test rate', async () => {
    expect(DEFAULT_WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE).toBe(0.01)
    const previous = process.env[WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE_ENV]
    process.env[WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE_ENV] = '1'
    try {
      const result = await runWorkspacePathSearchShadowSample({
        fixtureId: 'sample-config',
        query: 'target',
        snapshot: PATHS,
        actual: queryCatalog
      })
      expect(result.sampled).toBe(true)
    } finally {
      if (previous === undefined) {
        delete process.env[WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE_ENV]
      } else {
        process.env[WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE_ENV] = previous
      }
    }
  })
})
