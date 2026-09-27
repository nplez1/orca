import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspacePathSearchFenceIdentity } from '../../shared/workspace-path-search-contract'
import { WorkspacePathCatalogBuilder } from '../../shared/workspace-path-catalog-builder'
import {
  assertWorkspacePathSearchEquivalent,
  runWorkspacePathSearchOracle
} from '../../shared/__fixtures__/workspace-path-search-oracle'
import { WORKSPACE_PATH_SEARCH_QUERY_BATTERY } from '../../shared/__fixtures__/workspace-path-search-query-battery'
import { generateWorkspacePathCatalog } from '../../shared/__fixtures__/workspace-path-catalog'
import { WorkspacePathIndexWorkerClient } from './workspace-path-index-worker-client'

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

describe('WorkspacePathIndexWorkerClient', () => {
  it('bundles, resolves, and runs the worker entry with a transferred catalog', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-worker-'))
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const builder = new WorkspacePathCatalogBuilder({
      generationId: 'generation-1',
      maxBytes: 1024 * 1024,
      storage: 'packed-folded',
      freshness: 'no-known-gap'
    })
    expect(builder.addPath('src/target-file.ts', 'included')).toBe(true)
    builder.markScopeComplete('included')
    const catalog = builder.finish()
    expect(catalog).not.toBeNull()
    if (!catalog) {
      throw new Error('Catalog fixture did not build')
    }
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath)
    })
    await client.install('root-key', { catalog })
    const identity: WorkspacePathSearchFenceIdentity = {
      query: 'target',
      consumer: { consumerId: 'window-a', sequence: 1 },
      owner: {
        executionHost: { provider: 'local', incarnationId: 'worker-test' },
        authorizedCanonicalRoot: '/fixture'
      },
      generationId: null,
      mode: 'name-filter',
      scope: {
        pathSet: 'included',
        includeDotfiles: false,
        includeIgnoredFiles: false,
        excludePathSegments: []
      },
      pageBudget: { maxPaths: 10, maxSerializedBytes: 1024 }
    }
    const response = await client.query(
      'root-key',
      identity,
      '123e4567-e89b-42d3-a456-426614174025'
    )
    expect(response.rows).toEqual([{ relativePath: 'src/target-file.ts' }])
    expect(response.count).toEqual({ value: 1, provenance: 'exact-snapshot' })
    await client.drop('root-key')
    client.dispose()
  })

  it('drops optional postings before the catalog and remains oracle-exact', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-postings-drop-'))
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const paths = Array.from(
      { length: 2_000 },
      (_, index) =>
        `src/components/component-${index.toString(36)}/target-${index.toString(36)}.tsx`
    )
    const builder = new WorkspacePathCatalogBuilder({
      generationId: 'postings-drop-generation',
      maxBytes: 64 * 1024 * 1024,
      storage: 'packed-folded',
      freshness: 'no-known-gap'
    })
    expect(builder.addBatch(paths, 'included')).toBe(true)
    expect(builder.addBatch(paths, 'all')).toBe(true)
    builder.markScopeComplete('included')
    builder.markScopeComplete('all')
    builder.completeClassification()
    const catalog = builder.finish()
    if (!catalog?.trigramPostings) {
      throw new Error('Expected optional postings for the pressure test')
    }
    const queryStrategies: string[] = []
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath),
      onInstrumentation: (event) => {
        if (event.kind === 'query-metrics') {
          queryStrategies.push(event.record.strategy)
        }
      }
    })
    await client.install('postings-drop-root', { catalog })
    const reclaimedBytes = await client.discardOptionalStructures(
      'postings-drop-root',
      'postings-drop-generation'
    )
    expect(reclaimedBytes).toBeGreaterThan(0)
    const identity = createPostingsDropIdentity()
    const response = await client.query(
      'postings-drop-root',
      identity,
      '123e4567-e89b-42d3-a456-426614174077'
    )
    const expected = runWorkspacePathSearchOracle(paths, 'target', {
      scope: {
        rootPath: '/fixture',
        excludePaths: [],
        ignoredPaths: new Set<string>(),
        includeDotfiles: true,
        includeIgnoredFiles: true
      }
    })
    assertWorkspacePathSearchEquivalent('target', expected, {
      paths: response.rows.map((row) => row.relativePath),
      totalCount: response.count.value ?? -1
    })
    expect(queryStrategies).toContain('ordered-scan')
    await client.drop('postings-drop-root')
    client.dispose()
  })

  it('spills a ready resident catalog under pressure without changing its generation results', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-resident-spill-'))
    const spillDirectory = join(temporaryDirectory, 'host-local-spill')
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const paths = [
      ...generateWorkspacePathCatalog({
        size: 30_000,
        shape: 'realistic-shared-prefixes',
        seed: 0x50455246
      })
    ]
    const builder = new WorkspacePathCatalogBuilder({
      generationId: 'resident-to-spill-generation',
      maxBytes: 64 * 1024 * 1024,
      storage: 'packed-folded',
      freshness: 'no-known-gap'
    })
    expect(builder.addBatch(paths, 'all')).toBe(true)
    expect(builder.addBatch(paths, 'included')).toBe(true)
    builder.markScopeComplete('all')
    builder.markScopeComplete('included')
    builder.completeClassification()
    const catalog = builder.finish()
    if (!catalog) {
      throw new Error('Resident spill fixture did not build')
    }
    const residentBytes = catalog.retainedBytes
    const queryModes: string[] = []
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath),
      spillDirectory,
      onInstrumentation: (event) => {
        if (event.kind === 'query-metrics' && event.record.storageMode) {
          queryModes.push(event.record.storageMode)
        }
      }
    })
    await client.install('resident-spill-root', { catalog })
    const reclaimedBytes = await client.spillResidentCatalog(
      'resident-spill-root',
      'resident-to-spill-generation'
    )
    expect(reclaimedBytes).toBeGreaterThan(0)
    const identity = {
      query: 'module-1',
      consumer: { consumerId: 'resident-spill-window', sequence: 1 },
      owner: {
        executionHost: { provider: 'local', incarnationId: 'resident-spill-worker' },
        authorizedCanonicalRoot: '/fixture'
      },
      generationId: null,
      mode: 'name-filter' as const,
      scope: {
        pathSet: 'all' as const,
        includeDotfiles: true,
        includeIgnoredFiles: true,
        excludePathSegments: []
      },
      pageBudget: { maxPaths: 5_000, maxSerializedBytes: 1_000_000 }
    }
    const response = await client.query(
      'resident-spill-root',
      identity,
      '123e4567-e89b-42d3-a456-426614174084'
    )
    const expected = runWorkspacePathSearchOracle(paths, identity.query, {
      scope: {
        rootPath: '/fixture',
        excludePaths: [],
        ignoredPaths: new Set<string>(),
        includeDotfiles: true,
        includeIgnoredFiles: true
      }
    })
    assertWorkspacePathSearchEquivalent(identity.query, expected, {
      paths: response.rows.map((row) => row.relativePath),
      totalCount: response.count.value ?? -1
    })
    expect(queryModes).toContain('disk-spilled')
    expect(residentBytes - reclaimedBytes).toBeLessThan(residentBytes)
    await client.drop('resident-spill-root')
    client.dispose()
  })

  it('publishes a bounded worker delta over the previous generation', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-delta-worker-'))
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const builder = new WorkspacePathCatalogBuilder({
      generationId: 'delta-worker-base',
      maxBytes: 1024 * 1024,
      storage: 'packed-folded',
      freshness: 'no-known-gap'
    })
    expect(builder.addPath('src/old-target.ts', 'included')).toBe(true)
    expect(builder.addPath('src/old-target.ts', 'all')).toBe(true)
    builder.markScopeComplete('included')
    builder.markScopeComplete('all')
    builder.completeClassification()
    const catalog = builder.finish()
    if (!catalog) {
      throw new Error('Delta catalog fixture did not build')
    }
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath)
    })
    await client.install('delta-root', { catalog })
    const updated = await client.applyDelta({
      key: 'delta-root',
      expectedGenerationId: 'delta-worker-base',
      generationId: 'delta-worker-next',
      mutations: [
        { type: 'delete', path: 'src/old-target.ts' },
        { type: 'add', path: 'src/new-target.ts', pathSet: 'included' },
        { type: 'add', path: 'src/new-target.ts', pathSet: 'all' }
      ],
      freshness: 'no-known-gap',
      maxBytes: 1024 * 1024,
      correlationId: '123e4567-e89b-42d3-a456-426614174031'
    })
    expect(updated.generationId).toBe('delta-worker-next')
    const response = await client.query(
      'delta-root',
      {
        query: 'target',
        consumer: { consumerId: 'delta-window', sequence: 1 },
        owner: {
          executionHost: { provider: 'local', incarnationId: 'delta-worker' },
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
        pageBudget: { maxPaths: 10, maxSerializedBytes: 1024 }
      },
      '123e4567-e89b-42d3-a456-426614174032'
    )
    expect(response.rows.map((row) => row.relativePath)).toEqual(['src/new-target.ts'])
    expect(response.count).toEqual({ value: 1, provenance: 'exact-snapshot' })
    await client.drop('delta-root')
    client.dispose()
  })

  it('matches the 100,000-path query battery against the complete-snapshot oracle', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-oracle-worker-'))
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const snapshot = Array.from(
      generateWorkspacePathCatalog({
        size: 100_000,
        shape: 'realistic-shared-prefixes',
        seed: 0x50455246
      })
    )
    const builder = new WorkspacePathCatalogBuilder({
      generationId: 'oracle-generation',
      maxBytes: 256 * 1024 * 1024,
      storage: 'packed-folded',
      freshness: 'no-known-gap'
    })
    for (const path of snapshot) {
      expect(builder.addPath(path, 'all')).toBe(true)
    }
    builder.markScopeComplete('all')
    const catalog = builder.finish()
    expect(catalog).not.toBeNull()
    if (!catalog) {
      throw new Error('Oracle catalog fixture did not build')
    }
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath)
    })
    await client.install('oracle-root', { catalog })
    const baseIdentity: WorkspacePathSearchFenceIdentity = {
      query: '',
      consumer: { consumerId: 'oracle-window', sequence: 0 },
      owner: {
        executionHost: { provider: 'local', incarnationId: 'oracle-worker' },
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
      pageBudget: { maxPaths: 100, maxSerializedBytes: 100_000 }
    }
    for (const [sequence, testCase] of WORKSPACE_PATH_SEARCH_QUERY_BATTERY.entries()) {
      const identity = {
        ...baseIdentity,
        query: testCase.query,
        consumer: { consumerId: 'oracle-window', sequence }
      }
      const expected = runWorkspacePathSearchOracle(snapshot, testCase.query, {
        pageBudget: identity.pageBudget,
        scope: {
          rootPath: '/fixture',
          includeDotfiles: true,
          includeIgnoredFiles: true,
          excludePaths: [],
          ignoredPaths: new Set()
        }
      })
      const actual = await client.query(
        'oracle-root',
        identity,
        '123e4567-e89b-42d3-a456-426614174026'
      )
      expect(actual.state.countProvenance).toBe('exact-snapshot')
      if (actual.count.provenance !== 'exact-snapshot') {
        throw new Error('Worker returned a non-exact oracle response')
      }
      assertWorkspacePathSearchEquivalent(testCase.query, expected, {
        paths: actual.rows.map((row) => row.relativePath),
        totalCount: actual.count.value
      })
    }
    const cancellationIdentity = {
      ...baseIdentity,
      query: 'a',
      consumer: { consumerId: 'oracle-window', sequence: 99 }
    }
    const cancelledQuery = client.query(
      'oracle-root',
      cancellationIdentity,
      '123e4567-e89b-42d3-a456-426614174027'
    )
    setTimeout(() => client.cancel('local:oracle-worker:oracle-window'), 0)
    await expect(cancelledQuery).rejects.toThrow('cancelled')
    await client.drop('oracle-root')
    client.dispose()
  })
})

function createPostingsDropIdentity(): WorkspacePathSearchFenceIdentity {
  return {
    query: 'target',
    consumer: { consumerId: 'postings-drop-window', sequence: 1 },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'postings-drop-worker' },
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
