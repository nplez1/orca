import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import type { Store } from '../persistence'
import type { WorkspacePathSearchFenceIdentity } from '../../shared/workspace-path-search-contract'
import { buildWorkspacePathCatalogFromDiscovery } from '../ipc/workspace-path-catalog-builder'
import { WorkspacePathIndexWorkerClient } from './workspace-path-index-worker-client'

const canRunRipgrep = (() => {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

describe.skipIf(!canRunRipgrep)('worker-owned path catalog discovery', () => {
  it('streams bounded acknowledged ripgrep batches and publishes included scope first', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-worker-path-discovery-'))
    const root = temporaryDirectory
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'ignored'), { recursive: true })
    await writeFile(join(root, '.gitignore'), 'ignored/\n')
    await Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        writeFile(join(root, 'src', `bulk-${index}.ts`), '')
      )
    )
    await writeFile(join(root, 'src', 'target-visible.ts'), '')
    await writeFile(join(root, 'ignored', 'target-hidden.ts'), '')
    execFileSync('git', ['init', '-q'], { cwd: root })

    const workerPath = join(root, 'workspace-path-index-worker-entry.cjs')
    await import('esbuild').then(({ build }) =>
      build({
        entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: workerPath
      })
    )
    const worker = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath)
    })
    const buildId = 'discovery-build'
    const scopePublications: string[] = []
    let largestBatch = 0
    let batchCount = 0
    let inFlightBatches = 0
    let maximumInFlightBatches = 0
    const result = await buildWorkspacePathCatalogFromDiscovery(root, asStore(root), {
      firstScope: 'included',
      generationId: 'discovery-generation',
      overlayGenerationId: 'discovery-overlay',
      maxBytes: 1024 * 1024,
      freshness: 'no-known-gap',
      workerBuild: {
        begin: () =>
          worker.beginCatalogBuild({
            key: 'discovery-root',
            buildId,
            generationId: 'discovery-generation',
            firstScope: 'included',
            maxBytes: 1024 * 1024,
            correlationId: '123e4567-e89b-42d3-a456-426614174035'
          }),
        addBatch: async (pathSet, paths) => {
          largestBatch = Math.max(largestBatch, paths.length)
          batchCount += 1
          inFlightBatches += 1
          maximumInFlightBatches = Math.max(maximumInFlightBatches, inFlightBatches)
          await new Promise((resolveBatch) => setTimeout(resolveBatch, 1))
          const accepted = await worker.appendCatalogPathBatch(buildId, pathSet, paths)
          inFlightBatches -= 1
          return accepted
        },
        finishScope: (pathSet) => worker.finishCatalogScope(buildId, pathSet),
        abort: (preservePublished) => worker.abortCatalogBuild(buildId, preservePublished)
      },
      onWorkerScopePublished: (scope) => scopePublications.push(scope.readyScope)
    })
    expect(result.catalog).toBeNull()
    expect(result.degradationReason).toBeUndefined()
    expect(result.workerGenerationId).toBe('discovery-generation:overlay')
    expect(largestBatch).toBeLessThanOrEqual(256)
    expect(batchCount).toBeGreaterThan(1)
    expect(maximumInFlightBatches).toBe(1)
    expect(scopePublications).toEqual(['included', 'all'])
    const identity = discoveryIdentity()
    const response = await worker.query(
      'discovery-root',
      identity,
      '123e4567-e89b-42d3-a456-426614174036'
    )
    expect(response.rows.map((row) => row.relativePath)).toEqual([
      'ignored/target-hidden.ts',
      'src/target-visible.ts'
    ])
    await worker.drop('discovery-root')
    worker.dispose()
  })
})

function asStore(root: string): Store {
  const partial = {
    getRepos: () => [
      {
        id: 'repo-1',
        path: root,
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0,
        kind: 'git'
      }
    ],
    getSettings: () => ({})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: discovery only reads getRepos/getSettings in this local fixture, matching filesystem test stores.
  return partial as unknown as Store
}

function discoveryIdentity(): WorkspacePathSearchFenceIdentity {
  return {
    query: 'target',
    consumer: { consumerId: 'discovery-window', sequence: 1 },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'discovery-host' },
      authorizedCanonicalRoot: temporaryDirectory ?? '/fixture'
    },
    generationId: null,
    mode: 'name-filter',
    scope: {
      pathSet: 'all',
      includeDotfiles: true,
      includeIgnoredFiles: true,
      excludePathSegments: []
    },
    pageBudget: { maxPaths: 10, maxSerializedBytes: 10_000 }
  }
}
