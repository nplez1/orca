import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspacePathSearchFenceIdentity } from '../../shared/workspace-path-search-contract'
import { WorkspacePathCatalogBuilder } from '../../shared/workspace-path-catalog-builder'
import { WorkspacePathIndexWorkerClient } from './workspace-path-index-worker-client'

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

describe('worker catalog overlay admission', () => {
  it('keeps the completed requested scope usable when the second scope is over budget', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-worker-path-admission-'))
    const workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
    const sizingBuilder = new WorkspacePathCatalogBuilder({
      generationId: 'sizing',
      maxBytes: 1024 * 1024,
      storage: 'packed-folded'
    })
    expect(sizingBuilder.addPath('src/target.ts', 'included')).toBe(true)
    const collectionReservation = sizingBuilder.admissionBytes
    sizingBuilder.markScopeComplete('included')
    const sizingCatalog = sizingBuilder.finish({ retainPathLookup: true })
    expect(sizingCatalog).not.toBeNull()
    if (!sizingCatalog) {
      throw new Error('Expected the sizing catalog to publish')
    }
    const requestedScopeBytes = Math.max(
      collectionReservation,
      sizingBuilder.admissionBytes - (sizingCatalog.trigramPostings?.retainedBytes ?? 0)
    )
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath)
    })
    await client.beginCatalogBuild({
      key: 'admission-root',
      buildId: 'admission-build',
      generationId: 'admission-generation',
      firstScope: 'included',
      maxBytes: requestedScopeBytes,
      correlationId: '123e4567-e89b-42d3-a456-426614174050'
    })
    await expect(
      client.appendCatalogPathBatch('admission-build', 'included', ['src/target.ts'])
    ).resolves.toBe(true)
    const publication = await client.finishCatalogScope('admission-build', 'included')
    expect(publication).toMatchObject({ readyScope: 'included', complete: false })
    expect(publication.retainedBytes).toBeGreaterThan(0)
    expect(publication.degradationReason).toBe('over-budget')
    const response = await client.query(
      'admission-root',
      workerIdentity(),
      '123e4567-e89b-42d3-a456-426614174051'
    )
    expect(response.count).toEqual({ value: 1, provenance: 'exact-snapshot' })
    await client.drop('admission-root')
    client.dispose()
  })
})

function workerIdentity(): WorkspacePathSearchFenceIdentity {
  return {
    query: 'target',
    consumer: { consumerId: 'admission-window', sequence: 1 },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'admission-worker' },
      authorizedCanonicalRoot: '/fixture'
    },
    generationId: null,
    mode: 'name-filter',
    scope: {
      pathSet: 'included',
      includeDotfiles: true,
      includeIgnoredFiles: false,
      excludePathSegments: []
    },
    pageBudget: { maxPaths: 10, maxSerializedBytes: 1024 }
  }
}
