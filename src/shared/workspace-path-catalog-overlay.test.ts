import { describe, expect, it } from 'vitest'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchScopeDescriptor
} from './workspace-path-search-contract'
import { WORKSPACE_PATH_CATALOG_FLAGS, type WorkspacePathCatalog } from './workspace-path-catalog'
import { WorkspacePathCatalogBuilder } from './workspace-path-catalog-builder'
import {
  compactWorkspacePathCatalogGeneration,
  isWorkspacePathCatalogCompactionDue,
  WorkspacePathCatalogOverlayBuilder
} from './workspace-path-catalog-overlay'
import {
  queryWorkspacePathCatalog,
  WorkspacePathSearchCancelledError
} from './workspace-path-catalog-query'
import { generateWorkspacePathCatalog } from './__fixtures__/workspace-path-catalog'

const TEST_MEMORY_BUDGET = 512 * 1024 * 1024

describe('workspace path catalog overlays', () => {
  it('keeps a ready scope usable when a later overlay cannot be admitted', async () => {
    const builder = new WorkspacePathCatalogBuilder({
      generationId: 'base-ready',
      maxBytes: TEST_MEMORY_BUDGET,
      freshness: 'no-known-gap'
    })
    builder.addBatch(['src/ready-target.ts', 'src/another.ts'], 'included')
    builder.markScopeComplete('included')
    const catalog = requireCatalog(builder.finish())
    const overlay = new WorkspacePathCatalogOverlayBuilder(catalog, {
      generationId: 'over-budget-overlay',
      maxBytes: 0
    })
    expect(overlay.isOverBudget).toBe(true)
    expect(overlay.addPath('ignored/new-target.ts', 'all')).toBe(false)

    const response = await queryWorkspacePathCatalog(catalog, {
      identity: createIdentity('target', createScope('included', true, true, false))
    })
    expect(response.generationId).toBe('base-ready')
    expect(response.state.coverage).toBe('complete')
    expect(response.rows.map((row) => row.relativePath)).toEqual(['src/ready-target.ts'])
  })

  it('keeps prefix blocks, postings, delta merge, and compaction exact together', async () => {
    const base = buildCatalog(
      ['alpha/one-target.ts', 'alpha/two-target.ts', 'beta/old-target.ts'],
      'prefix-compressed'
    )
    expect(base.storageKind).toBe('prefix-compressed')
    expect(base.trigramPostings).toBeDefined()
    const overlayBuilder = new WorkspacePathCatalogOverlayBuilder(base, {
      generationId: 'prefix-block-delta',
      maxBytes: 2 * 1024 * 1024
    })
    overlayBuilder.deletePath('beta/old-target.ts')
    overlayBuilder.addPath('alpha/new-target.ts', 'included')
    const generation = { catalog: base, overlay: requireOverlay(overlayBuilder.finish()) }
    const scope = createScope('all', true, true, false)
    const response = await queryWorkspacePathCatalog(generation, {
      identity: createIdentity('target', scope)
    })
    expect(response.rows.map((row) => row.relativePath)).toEqual([
      'alpha/new-target.ts',
      'alpha/one-target.ts',
      'alpha/two-target.ts'
    ])
    const compacted = requireGeneration(
      compactWorkspacePathCatalogGeneration(generation, {
        generationId: 'prefix-block-delta-compacted',
        maxBytes: TEST_MEMORY_BUDGET
      })
    )
    expect(compacted.catalog.storageKind).toBe('prefix-compressed')
    expect(compacted.catalog.trigramPostings).toBeDefined()
    const compactedResponse = await queryWorkspacePathCatalog(compacted, {
      identity: createIdentity('target', scope)
    })
    expect(compactedResponse.rows).toEqual(response.rows)
    expect(compactedResponse.count).toEqual(response.count)
  })

  it('merges replacement, deletion, and insertion once, matching fresh build and compaction', async () => {
    const base = buildCatalog([
      'src/item-10.ts',
      'src/item-2.ts',
      'src/remove-target.ts',
      'src/replace-target.ts'
    ])
    const overlayBuilder = new WorkspacePathCatalogOverlayBuilder(base, {
      generationId: 'generation-overlay',
      maxBytes: 2 * 1024 * 1024
    })
    overlayBuilder.upsertPath(
      'src/replace-target.ts',
      WORKSPACE_PATH_CATALOG_FLAGS.included |
        WORKSPACE_PATH_CATALOG_FLAGS.all |
        WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown
    )
    overlayBuilder.deletePath('src/remove-target.ts')
    overlayBuilder.addPath('src/insert-target.ts', 'included')
    const overlay = overlayBuilder.finish()
    expect(overlay).not.toBeNull()
    const generation = { catalog: base, overlay: requireOverlay(overlay) }
    const scope = createScope('all', true, true, false)
    const response = await queryWorkspacePathCatalog(generation, {
      identity: createIdentity('target', scope)
    })
    expect(response.count).toEqual({ value: 2, provenance: 'exact-snapshot' })
    expect(response.rows.map((row) => row.relativePath)).toEqual([
      'src/insert-target.ts',
      'src/replace-target.ts'
    ])

    const compacted = compactWorkspacePathCatalogGeneration(generation, {
      generationId: 'generation-compacted',
      maxBytes: TEST_MEMORY_BUDGET
    })
    expect(compacted).not.toBeNull()
    const compactedResponse = await queryWorkspacePathCatalog(requireGeneration(compacted), {
      identity: createIdentity('target', scope)
    })
    expect(compactedResponse.rows).toEqual(response.rows)
    expect(compactedResponse.count).toEqual(response.count)
    const freshCatalog = buildCatalog([
      'src/item-10.ts',
      'src/item-2.ts',
      'src/replace-target.ts',
      'src/insert-target.ts'
    ])
    const freshResponse = await queryWorkspacePathCatalog(freshCatalog, {
      identity: createIdentity('target', scope)
    })
    expect(response.rows).toEqual(freshResponse.rows)
    expect(response.count).toEqual(freshResponse.count)
  })

  it('carries deltas forward while moving a subtree and matching a fresh build', async () => {
    const base = buildCatalog([
      'src/move/one.ts',
      'src/move/nested/two.ts',
      'src/replace.ts',
      'src/retain.ts'
    ])
    const firstBuilder = new WorkspacePathCatalogOverlayBuilder(base, {
      generationId: 'delta-first',
      maxBytes: 2 * 1024 * 1024
    })
    firstBuilder.upsertPath(
      'src/replace.ts',
      WORKSPACE_PATH_CATALOG_FLAGS.included |
        WORKSPACE_PATH_CATALOG_FLAGS.all |
        WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown
    )
    firstBuilder.addPath('src/move-destination/one.ts', 'included')
    const firstOverlay = requireOverlay(firstBuilder.finish())

    const secondBuilder = new WorkspacePathCatalogOverlayBuilder(base, {
      generationId: 'delta-second',
      maxBytes: 2 * 1024 * 1024,
      previousOverlay: firstOverlay
    })
    secondBuilder.deletePathPrefix('src/move')
    secondBuilder.addPath('src/move-destination/nested/two.ts', 'included')
    const secondOverlay = requireOverlay(secondBuilder.finish())
    const scope = createScope('all', true, true, false)
    const response = await queryWorkspacePathCatalog(
      { catalog: base, overlay: secondOverlay },
      { identity: createIdentity('src', scope) }
    )
    const expected = buildCatalog([
      'src/move-destination/one.ts',
      'src/move-destination/nested/two.ts',
      'src/replace.ts',
      'src/retain.ts'
    ])
    const fresh = await queryWorkspacePathCatalog(expected, {
      identity: createIdentity('src', scope)
    })
    expect(response.rows).toEqual(fresh.rows)
    expect(response.count).toEqual(fresh.count)
    expect(response.rows.filter((row) => row.relativePath === 'src/replace.ts')).toHaveLength(1)
  })

  it('classifies newly discovered all-scope paths through the existing policy snapshot', async () => {
    const base = buildCatalog(['src/visible.ts'])
    const overlayBuilder = new WorkspacePathCatalogOverlayBuilder(base, {
      generationId: 'new-all-scope-path',
      maxBytes: 1024 * 1024
    })
    overlayBuilder.addPath('dist/ignored-output.js', 'all')
    const generation = { catalog: base, overlay: requireOverlay(overlayBuilder.finish()) }
    const included = await queryWorkspacePathCatalog(generation, {
      identity: createIdentity('ignored-output', createScope('all', true, false, false))
    })
    expect(included.rows).toEqual([])
    const all = await queryWorkspacePathCatalog(generation, {
      identity: createIdentity('ignored-output', createScope('all', true, true, false))
    })
    expect(all.rows.map((row) => row.relativePath)).toEqual(['dist/ignored-output.js'])
    expect(all.rowClassificationFlags).toEqual([5])
  })

  it('replaces classification without retaining stale ignored flags', async () => {
    const builder = new WorkspacePathCatalogBuilder({
      generationId: 'classification-base',
      maxBytes: TEST_MEMORY_BUDGET,
      freshness: 'no-known-gap'
    })
    builder.addBatch(['src/reclassify-target.ts', 'src/keep.ts'], 'all')
    builder.addBatch(['src/keep.ts'], 'included')
    builder.markScopeComplete('all')
    builder.markScopeComplete('included')
    builder.completeClassification()
    const catalog = requireCatalog(builder.finish())
    const overlayBuilder = new WorkspacePathCatalogOverlayBuilder(catalog, {
      generationId: 'classification-replacement',
      maxBytes: 1024 * 1024
    })
    overlayBuilder.upsertPath(
      'src/reclassify-target.ts',
      WORKSPACE_PATH_CATALOG_FLAGS.included |
        WORKSPACE_PATH_CATALOG_FLAGS.all |
        WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown
    )
    const overlay = requireOverlay(overlayBuilder.finish())
    const response = await queryWorkspacePathCatalog(
      { catalog, overlay },
      {
        identity: createIdentity('target', createScope('all', true, false, false))
      }
    )
    expect(response.rows.map((row) => row.relativePath)).toEqual(['src/reclassify-target.ts'])
  })

  it('reconciles file-directory replacements without retaining old descendants', async () => {
    const base = buildCatalog([
      'src/replace',
      'src/tree/one.ts',
      'src/tree/nested/two.ts',
      'src/keep.ts'
    ])
    const delta = new WorkspacePathCatalogOverlayBuilder(base, {
      generationId: 'file-directory-transitions',
      maxBytes: 2 * 1024 * 1024
    })
    delta.deletePathPrefix('src/replace')
    delta.addPath('src/replace/child.ts', 'included')
    delta.addPath('src/replace/child.ts', 'all')
    delta.deletePathPrefix('src/tree')
    delta.upsertPath(
      'src/tree',
      WORKSPACE_PATH_CATALOG_FLAGS.included |
        WORKSPACE_PATH_CATALOG_FLAGS.all |
        WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown
    )
    const generation = { catalog: base, overlay: requireOverlay(delta.finish()) }
    const scope = createScope('all', true, true, false)
    const actual = await queryWorkspacePathCatalog(generation, {
      identity: createIdentity('src', scope)
    })
    const expected = await queryWorkspacePathCatalog(
      buildCatalog(['src/replace/child.ts', 'src/tree', 'src/keep.ts']),
      { identity: createIdentity('src', scope) }
    )
    expect(actual.rows).toEqual(expected.rows)
    expect(actual.count).toEqual(expected.count)
  })

  it('triggers compaction at the delta threshold and observes cancellation between chunks', async () => {
    const base = buildCatalog(['src/base.ts'])
    const overlayBuilder = new WorkspacePathCatalogOverlayBuilder(base, {
      generationId: 'large-delta',
      maxBytes: 16 * 1024 * 1024
    })
    for (let index = 0; index < 1_024; index += 1) {
      overlayBuilder.addPath(`src/delta-${index}.ts`, 'all')
    }
    const overlay = requireOverlay(overlayBuilder.finish())
    expect(isWorkspacePathCatalogCompactionDue({ catalog: base, overlay })).toBe(true)

    const manyPaths = [
      ...generateWorkspacePathCatalog({ size: 100_000, profile: 'realistic-shared-prefixes' })
    ]
    const catalog = buildCatalog(manyPaths)
    let cancellationChecks = 0
    let cancellationObserved = false
    try {
      await queryWorkspacePathCatalog(catalog, {
        identity: createIdentity('a', createScope('all', true, true, false)),
        cancellation: {
          isCancelled: () => {
            cancellationChecks += 1
            return cancellationChecks >= 3
          }
        },
        yieldToWorker: async () => undefined
      })
    } catch (error) {
      cancellationObserved = error instanceof WorkspacePathSearchCancelledError
    }
    expect(cancellationObserved).toBe(true)
    expect(cancellationChecks).toBeGreaterThanOrEqual(3)
  })
})

function buildCatalog(
  paths: readonly string[],
  storage: 'folded-strings' | 'packed-folded' | 'prefix-compressed' = 'folded-strings'
): WorkspacePathCatalog {
  const builder = new WorkspacePathCatalogBuilder({
    generationId: `overlay-base-${paths.length}`,
    maxBytes: TEST_MEMORY_BUDGET,
    storage,
    freshness: 'no-known-gap'
  })
  builder.addBatch(paths, 'all')
  builder.addBatch(paths, 'included')
  builder.markScopeComplete('all')
  builder.markScopeComplete('included')
  builder.completeClassification()
  return requireCatalog(builder.finish())
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
  scope: WorkspacePathSearchScopeDescriptor
): WorkspacePathSearchFenceIdentity {
  return {
    query,
    consumer: { consumerId: 'catalog-overlay-test', sequence: 1 },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'overlay-test-host' },
      authorizedCanonicalRoot: '/fixture'
    },
    generationId: null,
    mode: 'name-filter',
    scope,
    pageBudget: { maxPaths: 5_000, maxSerializedBytes: Number.POSITIVE_INFINITY }
  }
}

function requireCatalog(catalog: WorkspacePathCatalog | null): WorkspacePathCatalog {
  if (!catalog) {
    throw new Error('Expected workspace path catalog')
  }
  return catalog
}

function requireOverlay(
  overlay: ReturnType<WorkspacePathCatalogOverlayBuilder['finish']>
): NonNullable<ReturnType<WorkspacePathCatalogOverlayBuilder['finish']>> {
  if (!overlay) {
    throw new Error('Expected workspace path overlay')
  }
  return overlay
}

function requireGeneration(
  generation: ReturnType<typeof compactWorkspacePathCatalogGeneration>
): NonNullable<ReturnType<typeof compactWorkspacePathCatalogGeneration>> {
  if (!generation) {
    throw new Error('Expected compacted generation')
  }
  return generation
}
