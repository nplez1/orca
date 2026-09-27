import { build } from 'esbuild'
import { mkdtemp, readdir, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspacePathSearchFenceIdentity } from '../../shared/workspace-path-search-contract'
import { generateWorkspacePathCatalog } from '../../shared/__fixtures__/workspace-path-catalog'
import { WorkspacePathCatalogBuilder } from '../../shared/workspace-path-catalog-builder'
import { WorkspacePathIndexWorkerClient } from './workspace-path-index-worker-client'

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

function workerIdentity(
  pathSet: 'included' | 'all',
  includeIgnoredFiles: boolean,
  sequence: number
): WorkspacePathSearchFenceIdentity {
  return {
    query: 'target',
    consumer: { consumerId: 'stream-window', sequence },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'stream-worker' },
      authorizedCanonicalRoot: '/fixture'
    },
    generationId: null,
    mode: 'name-filter',
    scope: {
      pathSet,
      includeDotfiles: true,
      includeIgnoredFiles,
      excludePathSegments: []
    },
    pageBudget: { maxPaths: 10, maxSerializedBytes: 1024 }
  }
}

describe('WorkspacePathIndexWorkerClient streamed builds', () => {
  it('spills a rejected resident build and answers both scopes from disk blocks', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-spilled-build-'))
    const spillDirectory = join(temporaryDirectory, 'host-local-spill')
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const spillQueryMetrics: {
      storageMode?: string
      spillBlocksRead?: number
      spillBytesRead?: number
      decodedBlockCacheHits?: number
    }[] = []
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath),
      spillDirectory,
      onInstrumentation: (event) => {
        if (event.kind === 'query-metrics') {
          spillQueryMetrics.push({
            storageMode: event.record.storageMode,
            spillBlocksRead: event.record.spillBlocksRead,
            spillBytesRead: event.record.spillBytesRead,
            decodedBlockCacheHits: event.record.decodedBlockCacheHits
          })
        }
      }
    })
    await client.beginCatalogBuild({
      key: 'spill-worker-root',
      buildId: 'spill-worker-build',
      generationId: 'spill-worker-generation',
      firstScope: 'included',
      maxBytes: 1,
      correlationId: '123e4567-e89b-42d3-a456-426614174070'
    })
    await expect(
      client.appendCatalogPathBatch('spill-worker-build', 'included', [
        'src/target-2.ts',
        'src/target-10.ts'
      ])
    ).resolves.toBe(true)
    await expect(
      client.finishCatalogScope('spill-worker-build', 'included')
    ).resolves.toMatchObject({
      storageMode: 'disk-spilled',
      complete: false,
      retainedBytes: expect.any(Number)
    })
    await client.appendCatalogPathBatch('spill-worker-build', 'all', [
      'ignored/target.txt',
      'src/target-10.ts',
      'src/target-2.ts'
    ])
    const completed = await client.finishCatalogScope('spill-worker-build', 'all')
    expect(completed).toMatchObject({ storageMode: 'disk-spilled', complete: true })
    const delta = await client.applyDelta({
      key: 'spill-worker-root',
      expectedGenerationId: completed.generationId,
      generationId: 'spill-worker-delta',
      mutations: [
        { type: 'delete', path: 'src/target-2.ts' },
        { type: 'delete-prefix', path: 'ignored' },
        { type: 'add', path: 'src/target-3.ts', pathSet: 'all' }
      ],
      freshness: 'no-known-gap',
      maxBytes: 1024 * 1024,
      correlationId: '123e4567-e89b-42d3-a456-426614174072'
    })
    expect(delta).toMatchObject({ compacted: true, deltaPathCount: 3 })
    const response = await client.query(
      'spill-worker-root',
      { ...workerIdentity('all', true, 1), query: 'target' },
      '123e4567-e89b-42d3-a456-426614174073'
    )
    expect(response.count).toEqual({ value: 2, provenance: 'exact-snapshot' })
    expect(response.rows.map((row) => row.relativePath)).toEqual([
      'src/target-3.ts',
      'src/target-10.ts'
    ])
    expect(spillQueryMetrics).toContainEqual({
      storageMode: 'disk-spilled',
      spillBlocksRead: expect.any(Number),
      spillBytesRead: expect.any(Number),
      decodedBlockCacheHits: 0
    })
    await client.drop('spill-worker-root')
    for (
      let attempt = 0;
      attempt < 50 && (await readdir(spillDirectory)).length > 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(await readdir(spillDirectory)).toEqual([])
    client.dispose()
  })

  it('rebuilds a truncated spill generation instead of returning false-empty', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-spill-corruption-'))
    const spillDirectory = join(temporaryDirectory, 'host-local-spill')
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath),
      spillDirectory
    })
    await client.beginCatalogBuild({
      key: 'spill-corruption-root',
      buildId: 'spill-corruption-build',
      generationId: 'spill-corruption-generation',
      firstScope: 'included',
      maxBytes: 1,
      correlationId: '123e4567-e89b-42d3-a456-426614174080'
    })
    await client.appendCatalogPathBatch('spill-corruption-build', 'included', ['src/target.ts'])
    await client.finishCatalogScope('spill-corruption-build', 'included')
    await client.appendCatalogPathBatch('spill-corruption-build', 'all', ['src/target.ts'])
    const spilled = await client.finishCatalogScope('spill-corruption-build', 'all')
    expect(spilled.storageMode).toBe('disk-spilled')
    const spillFiles = (await readdir(spillDirectory)).filter((path) => path.endsWith('.wpc'))
    expect(spillFiles.length).toBeGreaterThan(0)
    await Promise.all(spillFiles.map((path) => truncate(join(spillDirectory, path), 1)))
    await expect(
      client.query(
        'spill-corruption-root',
        { ...workerIdentity('all', true, 1), query: 'target' },
        '123e4567-e89b-42d3-a456-426614174081'
      )
    ).rejects.toThrow('spill')

    await client.beginCatalogBuild({
      key: 'spill-corruption-root',
      buildId: 'resident-rebuild',
      generationId: 'resident-rebuild-generation',
      firstScope: 'included',
      maxBytes: 1024 * 1024,
      correlationId: '123e4567-e89b-42d3-a456-426614174082'
    })
    await client.appendCatalogPathBatch('resident-rebuild', 'included', ['src/rebuilt-target.ts'])
    await expect(client.finishCatalogScope('resident-rebuild', 'included')).resolves.toMatchObject({
      storageMode: 'packed-folded',
      complete: false
    })
    await client.appendCatalogPathBatch('resident-rebuild', 'all', ['src/rebuilt-target.ts'])
    await expect(client.finishCatalogScope('resident-rebuild', 'all')).resolves.toMatchObject({
      storageMode: 'packed-folded',
      complete: true
    })
    const response = await client.query(
      'spill-corruption-root',
      { ...workerIdentity('all', true, 2), query: 'target' },
      '123e4567-e89b-42d3-a456-426614174083'
    )
    expect(response.rows).toEqual([{ relativePath: 'src/rebuilt-target.ts' }])
    await client.drop('spill-corruption-root')
    client.dispose()
  })

  it('recovers a resident index after shrink', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-spill-recovery-'))
    const spillDirectory = join(temporaryDirectory, 'host-local-spill')
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath),
      spillDirectory
    })
    await client.beginCatalogBuild({
      key: 'shrink-recovery-root',
      buildId: 'spill-before-shrink',
      generationId: 'spill-before-shrink-generation',
      firstScope: 'included',
      maxBytes: 1,
      correlationId: '123e4567-e89b-42d3-a456-426614174074'
    })
    await client.appendCatalogPathBatch('spill-before-shrink', 'included', ['src/old-target.ts'])
    await client.finishCatalogScope('spill-before-shrink', 'included')
    await client.appendCatalogPathBatch('spill-before-shrink', 'all', ['src/old-target.ts'])
    await client.finishCatalogScope('spill-before-shrink', 'all')

    await client.beginCatalogBuild({
      key: 'shrink-recovery-root',
      buildId: 'resident-after-shrink',
      generationId: 'resident-after-shrink-generation',
      firstScope: 'included',
      maxBytes: 1024 * 1024,
      correlationId: '123e4567-e89b-42d3-a456-426614174075'
    })
    await client.appendCatalogPathBatch('resident-after-shrink', 'included', ['src/new-target.ts'])
    await expect(
      client.finishCatalogScope('resident-after-shrink', 'included')
    ).resolves.toMatchObject({ storageMode: 'packed-folded', complete: false })
    await client.appendCatalogPathBatch('resident-after-shrink', 'all', ['src/new-target.ts'])
    await expect(client.finishCatalogScope('resident-after-shrink', 'all')).resolves.toMatchObject({
      storageMode: 'packed-folded',
      complete: true
    })
    const response = await client.query(
      'shrink-recovery-root',
      workerIdentity('all', true, 1),
      '123e4567-e89b-42d3-a456-426614174076'
    )
    expect(response.rows).toEqual([{ relativePath: 'src/new-target.ts' }])
    await client.drop('shrink-recovery-root')
    client.dispose()
  })

  it('cancels a build during a yielding worker sort without publishing it', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-build-cancel-'))
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath)
    })
    await client.beginCatalogBuild({
      key: 'cancel-sort-root',
      buildId: 'cancel-sort-build',
      generationId: 'cancel-sort-generation',
      firstScope: 'included',
      maxBytes: 64 * 1024 * 1024,
      correlationId: '123e4567-e89b-42d3-a456-426614174052'
    })
    let batch: string[] = []
    for (const path of generateWorkspacePathCatalog({
      size: 50_000,
      shape: 'realistic-shared-prefixes',
      seed: 0x50455246
    })) {
      batch.push(path)
      if (batch.length === 256) {
        await client.appendCatalogPathBatch('cancel-sort-build', 'included', batch)
        batch = []
      }
    }
    if (batch.length > 0) {
      await client.appendCatalogPathBatch('cancel-sort-build', 'included', batch)
    }
    const finishing = client.finishCatalogScope('cancel-sort-build', 'included')
    const aborting = client.abortCatalogBuild('cancel-sort-build')
    await expect(finishing).rejects.toThrow('cancelled')
    await aborting
    await expect(
      client.query(
        'cancel-sort-root',
        workerIdentity('included', false, 1),
        '123e4567-e89b-42d3-a456-426614174053'
      )
    ).rejects.toThrow('generation is unavailable')
    client.dispose()
  })

  it('recovers on a new worker after a crash during an acknowledged build batch', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-build-crash-'))
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const workerHolder: { current: Worker | null } = { current: null }
    let workerCount = 0
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => {
        workerCount += 1
        const spawned = new Worker(workerPath)
        workerHolder.current = spawned
        return spawned
      }
    })
    await client.beginCatalogBuild({
      key: 'crash-root',
      buildId: 'crashed-build',
      generationId: 'crashed-generation',
      firstScope: 'included',
      maxBytes: 64 * 1024 * 1024,
      correlationId: '123e4567-e89b-42d3-a456-426614174054'
    })
    const heavyBatch = Array.from(
      { length: 256 },
      (_, index) => `src/${index}-${'x'.repeat(8_000)}.ts`
    )
    const pendingBatch = client.appendCatalogPathBatch('crashed-build', 'included', heavyBatch)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await workerHolder.current?.terminate()
    await expect(pendingBatch).rejects.toThrow()

    await client.beginCatalogBuild({
      key: 'crash-root',
      buildId: 'recovered-build',
      generationId: 'recovered-generation',
      firstScope: 'included',
      maxBytes: 1024 * 1024,
      correlationId: '123e4567-e89b-42d3-a456-426614174055'
    })
    await client.appendCatalogPathBatch('recovered-build', 'included', ['src/recovered-target.ts'])
    await expect(client.finishCatalogScope('recovered-build', 'included')).resolves.toMatchObject({
      generationId: 'recovered-generation',
      readyScope: 'included'
    })
    const response = await client.query(
      'crash-root',
      workerIdentity('included', false, 1),
      '123e4567-e89b-42d3-a456-426614174056'
    )
    expect(response.rows).toEqual([{ relativePath: 'src/recovered-target.ts' }])
    expect(workerCount).toBe(2)
    await client.drop('crash-root')
    client.dispose()
  })

  it('answers an existing generation while a replacement build is sorting', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-build-yield-'))
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath)
    })
    const baseBuilder = new WorkspacePathCatalogBuilder({
      generationId: 'existing-generation',
      maxBytes: 1024 * 1024,
      storage: 'packed-folded',
      freshness: 'no-known-gap'
    })
    expect(baseBuilder.addPath('src/existing-target.ts', 'included')).toBe(true)
    baseBuilder.markScopeComplete('included')
    const baseCatalog = baseBuilder.finish()
    if (!baseCatalog) {
      throw new Error('Prior generation fixture failed')
    }
    await client.install('yield-root', { catalog: baseCatalog })
    await client.beginCatalogBuild({
      key: 'yield-root',
      buildId: 'yield-build',
      generationId: 'replacement-generation',
      firstScope: 'included',
      maxBytes: 64 * 1024 * 1024,
      correlationId: '123e4567-e89b-42d3-a456-426614174057'
    })
    let batch: string[] = []
    for (const path of generateWorkspacePathCatalog({
      size: 50_000,
      shape: 'realistic-shared-prefixes',
      seed: 0x50455246
    })) {
      batch.push(path)
      if (batch.length === 256) {
        await client.appendCatalogPathBatch('yield-build', 'included', batch)
        batch = []
      }
    }
    if (batch.length > 0) {
      await client.appendCatalogPathBatch('yield-build', 'included', batch)
    }
    const finishing = client.finishCatalogScope('yield-build', 'included')
    const query = client.query(
      'yield-root',
      {
        ...workerIdentity('included', false, 1),
        generationId: 'existing-generation'
      },
      '123e4567-e89b-42d3-a456-426614174058'
    )
    await expect(
      Promise.race([query.then(() => 'query'), finishing.then(() => 'build')])
    ).resolves.toBe('query')
    await expect(query).resolves.toMatchObject({
      generationId: 'existing-generation',
      rows: [{ relativePath: 'src/existing-target.ts' }]
    })
    await finishing
    await client.drop('yield-root')
    client.dispose()
  })

  it('streams acknowledged batches and publishes the requested scope before membership expansion', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-index-stream-build-'))
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath)
    })
    await client.beginCatalogBuild({
      key: 'stream-root',
      buildId: 'build-1',
      generationId: 'generation-1',
      firstScope: 'included',
      maxBytes: 1024 * 1024,
      correlationId: '123e4567-e89b-42d3-a456-426614174028'
    })
    await expect(
      client.appendCatalogPathBatch('build-1', 'included', ['src/visible-target.ts'])
    ).resolves.toBe(true)
    const firstScope = await client.finishCatalogScope('build-1', 'included')
    expect(firstScope).toMatchObject({ readyScope: 'included', complete: false })
    const includedResponse = await client.query(
      'stream-root',
      workerIdentity('included', false, 1),
      '123e4567-e89b-42d3-a456-426614174029'
    )
    expect(includedResponse.rows).toEqual([{ relativePath: 'src/visible-target.ts' }])

    await expect(
      client.appendCatalogPathBatch('build-1', 'all', ['ignored/hidden-target.ts'])
    ).resolves.toBe(true)
    await expect(client.finishCatalogScope('build-1', 'all')).resolves.toMatchObject({
      readyScope: 'all',
      complete: true
    })
    const allResponse = await client.query(
      'stream-root',
      workerIdentity('all', true, 2),
      '123e4567-e89b-42d3-a456-426614174030'
    )
    expect(allResponse.rows.map((row) => row.relativePath)).toEqual([
      'ignored/hidden-target.ts',
      'src/visible-target.ts'
    ])

    await client.beginCatalogBuild({
      key: 'stream-root',
      buildId: 'build-cancelled',
      generationId: 'generation-cancelled',
      firstScope: 'included',
      maxBytes: 1024 * 1024,
      correlationId: '123e4567-e89b-42d3-a456-426614174032'
    })
    await client.appendCatalogPathBatch('build-cancelled', 'included', ['src/new-target.ts'])
    await client.finishCatalogScope('build-cancelled', 'included')
    await client.abortCatalogBuild('build-cancelled')
    await expect(
      client.query(
        'stream-root',
        workerIdentity('included', false, 3),
        '123e4567-e89b-42d3-a456-426614174033'
      )
    ).rejects.toThrow('generation is unavailable')
    client.dispose()
  })
})
