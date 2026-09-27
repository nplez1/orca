import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchOwnerIdentity,
  WorkspacePathSearchPathSet
} from '../../shared/workspace-path-search-contract'
import { createCompleteWorkspacePathSearchResponse } from '../../shared/workspace-path-search-response'
import { WorkspacePathCatalogBuilder } from '../../shared/workspace-path-catalog-builder'
import { publishWorkspacePathCatalog } from '../../shared/workspace-path-catalog-builder-publication'
import { WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES } from '../../shared/__fixtures__/workspace-path-memory-measurement'
import { WorkspacePathIndexAdmission } from './workspace-path-index-admission'
import type {
  WorkspacePathIndexBuildRequest,
  WorkspacePathIndexBuildResult
} from './workspace-path-index-build'
import { WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES } from './workspace-path-index-build-budget'
import { WorkspacePathIndexService } from './workspace-path-index-service'
import { WorkspacePathIndexWorkerClient } from './workspace-path-index-worker-client'
import type { WorkspacePathIndexBuildWorkerResult } from './workspace-path-index-worker-protocol'

const OWNER: WorkspacePathSearchOwnerIdentity = {
  executionHost: { provider: 'local', incarnationId: 'publication-admission-host' },
  authorizedCanonicalRoot: '/publication-admission-root'
}
/** Small enough that every real catalog exceeds it, standing in for the 256 MiB root cap. */
const REFUSED_ROOT_BUDGET = 256
const REFUSED_HOST_BUDGET = 16_384

function identity(sequence: number): WorkspacePathSearchFenceIdentity {
  return {
    query: 'target',
    consumer: { consumerId: 'publication-admission-window', sequence },
    owner: OWNER,
    generationId: null,
    mode: 'name-filter',
    scope: {
      pathSet: 'included',
      includeDotfiles: false,
      includeIgnoredFiles: false,
      excludePathSegments: []
    },
    pageBudget: { maxPaths: 10, maxSerializedBytes: 10_000 }
  }
}

function queryIdentity(generationId: string): WorkspacePathSearchFenceIdentity {
  return { ...identity(1), generationId }
}

const includeArgs = {
  owner: OWNER,
  listingPolicyVersion: 'listing-v1',
  foldVersion: 'fold-v1',
  buildReservationBytes: REFUSED_ROOT_BUDGET,
  firstScope: 'included' as const,
  correlationId: '123e4567-e89b-42d3-a456-426614174060'
}

describe('workspace path index publication admission', () => {
  it('publishes a root whose build accounting exceeds the root cap but whose retained bytes fit', () => {
    const builder = new WorkspacePathCatalogBuilder({
      generationId: 'build-bound-generation',
      maxBytes: WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES,
      storage: 'packed-folded'
    })
    for (const path of ['src/alpha.ts', 'src/beta.ts', 'src/gamma.ts']) {
      expect(builder.addPath(path, 'included')).toBe(true)
    }
    builder.markScopeComplete('included')
    builder.markScopeComplete('all')
    const state = builder.workerPublicationState(0)
    // reservedBuildBytes is the builder's own build accounting, reported here above the root cap.
    const args = {
      ...state,
      reservedBuildBytes: WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES + 1
    }
    const resident = publishWorkspacePathCatalog({
      ...args,
      maxBytes: WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES
    })
    expect(resident).not.toBeNull()
    expect(resident?.storageKind).toBe('packed-folded')
    expect(resident?.retainedBytes).toBeLessThan(WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES)
    // The same root under the root cap bound would have degraded/spilled instead of publishing.
    expect(
      publishWorkspacePathCatalog({
        ...args,
        maxBytes: WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
      })
    ).toBeNull()
  })

  it('never serves a generation whose retained bytes exceed the root cap', async () => {
    const dropped: string[] = []
    const build = vi.fn(
      async (request: WorkspacePathIndexBuildRequest): Promise<WorkspacePathIndexBuildResult> => {
        request.onScopePublished(request.generationId, 4_096, true)
        return { generationId: request.generationId, retainedBytes: 4_096 }
      }
    )
    const query = vi.fn(
      async ({ identity: requestIdentity }: { identity: WorkspacePathSearchFenceIdentity }) =>
        createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: ['src/target.ts'],
          totalCount: 1,
          generationId: requestIdentity.generationId ?? 'generation'
        })
    )
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build,
      query,
      admission: new WorkspacePathIndexAdmission(REFUSED_ROOT_BUDGET, REFUSED_HOST_BUDGET),
      dropRejectedGeneration: (key, generationId) => dropped.push(`${key}:${generationId}`)
    })
    await expect(
      service.search({
        identity: identity(1),
        listingPolicyVersion: 'listing-v1',
        foldVersion: 'fold-v1',
        buildReservationBytes: REFUSED_ROOT_BUDGET,
        correlationId: '123e4567-e89b-42d3-a456-426614174061'
      })
    ).resolves.toMatchObject({ ready: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(service.ensure(includeArgs)).resolves.toMatchObject({
      ready: false,
      reason: 'over-budget'
    })
    await expect(
      service.search({
        identity: identity(2),
        listingPolicyVersion: 'listing-v1',
        foldVersion: 'fold-v1',
        buildReservationBytes: REFUSED_ROOT_BUDGET,
        correlationId: '123e4567-e89b-42d3-a456-426614174062'
      })
    ).resolves.toMatchObject({ ready: false, reason: 'over-budget' })
    // The refused generation is dropped, not served, and the live scan takes over.
    const request = build.mock.calls[0]?.[0]
    expect(request).toBeDefined()
    expect(dropped).toContain(`${request?.key}:${request?.generationId}`)
    expect(query).not.toHaveBeenCalled()
    service.dispose()
  })
})

describe('workspace path index refused generation recovery', () => {
  let temporaryDirectory: string | null = null
  let workerPath = ''

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-publication-admission-'))
    workerPath = join(temporaryDirectory, 'workspace-path-index-worker-entry.cjs')
    await build({
      entryPoints: [resolve(__dirname, 'workspace-path-index-worker-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: workerPath
    })
  })

  afterAll(async () => {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
    temporaryDirectory = null
  })

  it('drops the refused generation from the worker so it can never be queried', async () => {
    const client = new WorkspacePathIndexWorkerClient({
      workerFactory: () => new Worker(workerPath)
    })
    const published: string[] = []
    const resolveBuild = createWorkerBuild(client, published)
    const requests: WorkspacePathIndexBuildRequest[] = []
    const query = vi.fn(async () => {
      throw new Error('A refused generation must never be queried')
    })
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build: async (request) => {
        requests.push(request)
        return resolveBuild(request)
      },
      query,
      admission: new WorkspacePathIndexAdmission(REFUSED_ROOT_BUDGET, REFUSED_HOST_BUDGET),
      dropRejectedGeneration: (key, generationId) => {
        void client.drop(key, generationId).catch(() => undefined)
      }
    })
    const searchArgs = {
      identity: identity(1),
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: REFUSED_ROOT_BUDGET,
      correlationId: '123e4567-e89b-42d3-a456-426614174063'
    }
    await service.search(searchArgs)
    await vi.waitFor(async () => {
      await expect(service.search({ ...searchArgs, identity: identity(2) })).resolves.toMatchObject(
        { ready: false, reason: 'over-budget' }
      )
    })
    expect(published.length).toBeGreaterThan(0)
    const key = requests[0]?.key
    expect(key).toBeDefined()
    // Every generation the worker published was refused, so the worker must retain none of them.
    await vi.waitFor(async () => {
      for (const generationId of published) {
        await expect(
          client.query(
            key ?? '',
            queryIdentity(generationId),
            '123e4567-e89b-42d3-a456-426614174064'
          )
        ).rejects.toThrow()
      }
    })
    expect(query).not.toHaveBeenCalled()
    service.dispose()
    client.dispose()
  })
})

function createWorkerBuild(
  client: WorkspacePathIndexWorkerClient,
  published: string[]
): (request: WorkspacePathIndexBuildRequest) => Promise<WorkspacePathIndexBuildResult> {
  const pathsByScope: Record<WorkspacePathSearchPathSet, string[]> = {
    included: Array.from({ length: 20 }, (_, index) => `src/feature-${index}/index.ts`),
    all: Array.from({ length: 20 }, (_, index) => `build/generated-${index}/chunk.ts`)
  }
  return async (request) => {
    const buildId = `${request.generationId}:${request.buildGeneration}`
    await client.beginCatalogBuild({
      key: request.key,
      buildId,
      generationId: request.generationId,
      firstScope: request.firstScope,
      maxBytes: WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES,
      correlationId: request.correlationId
    })
    const scopes: WorkspacePathSearchPathSet[] =
      request.firstScope === 'included' ? ['included', 'all'] : ['all', 'included']
    let latest: WorkspacePathIndexBuildWorkerResult | null = null
    for (const pathSet of scopes) {
      await client.appendCatalogPathBatch(buildId, pathSet, pathsByScope[pathSet])
      latest = await client.finishCatalogScope(buildId, pathSet)
      published.push(latest.generationId)
      request.onScopePublished(latest.generationId, latest.retainedBytes, latest.complete)
    }
    if (!latest) {
      throw new Error('Worker build published no scope')
    }
    return {
      generationId: latest.generationId,
      retainedBytes: latest.retainedBytes,
      ...(latest.storageMode ? { storageMode: latest.storageMode } : {}),
      ...(latest.degradationReason ? { degradationReason: latest.degradationReason } : {})
    }
  }
}
