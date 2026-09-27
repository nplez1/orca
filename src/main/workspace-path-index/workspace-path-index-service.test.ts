import { describe, expect, it, vi } from 'vitest'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchOwnerIdentity
} from '../../shared/workspace-path-search-contract'
import { createCompleteWorkspacePathSearchResponse } from '../../shared/workspace-path-search-response'
import { WorkspacePathIndexAdmission } from './workspace-path-index-admission'
import { WorkspacePathIndexService } from './workspace-path-index-service'

const OWNER: WorkspacePathSearchOwnerIdentity = {
  executionHost: { provider: 'local', incarnationId: 'host-1' },
  authorizedCanonicalRoot: '/workspace/a'
}

function identity(
  owner = OWNER,
  consumerId = 'window-1',
  sequence = 1
): WorkspacePathSearchFenceIdentity {
  return {
    query: 'target',
    consumer: { consumerId, sequence },
    owner,
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

async function settleBuild(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('WorkspacePathIndexService', () => {
  it('spills a ready root after optional postings fail to free enough admission', async () => {
    const otherOwner: WorkspacePathSearchOwnerIdentity = {
      ...OWNER,
      authorizedCanonicalRoot: '/workspace/b'
    }
    const reclaimOptionalStructures = vi.fn(async () => 0)
    const spillResidentCatalog = vi.fn(async () => 500)
    const build = vi.fn(
      async (request: { generationId: string; owner: WorkspacePathSearchOwnerIdentity }) => ({
        generationId: request.generationId,
        retainedBytes:
          request.owner.authorizedCanonicalRoot === OWNER.authorizedCanonicalRoot ? 800 : 64
      })
    )
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build,
      reclaimOptionalStructures,
      spillResidentCatalog,
      admission: new WorkspacePathIndexAdmission(1_000, 1_000),
      query: async ({ identity: requestIdentity }) =>
        createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: ['src/target.ts'],
          totalCount: 1,
          generationId: requestIdentity.generationId ?? 'generation'
        })
    })
    const firstArgs = {
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 800,
      correlationId: '123e4567-e89b-42d3-a456-426614174078'
    }
    await service.ensure(firstArgs)
    await settleBuild()
    expect((await service.ensure(firstArgs)).ready).toBe(true)
    const secondArgs = {
      ...firstArgs,
      owner: otherOwner,
      buildReservationBytes: 600,
      correlationId: '123e4567-e89b-42d3-a456-426614174079'
    }
    await expect(service.ensure(secondArgs)).resolves.toMatchObject({
      ready: false,
      reason: 'building'
    })
    expect(reclaimOptionalStructures).toHaveBeenCalledWith(expect.any(String), expect.any(String))
    expect(spillResidentCatalog).toHaveBeenCalledWith(expect.any(String), expect.any(String))
    await settleBuild()
    expect((await service.ensure(secondArgs)).ready).toBe(true)
    expect(service.hasIndex(OWNER)).toBe(true)
    expect((await service.ensure(firstArgs)).ready).toBe(true)
    expect(build).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('reauthorizes cache hits and coalesces builds under one ownership key', async () => {
    const buildResult = deferred<{ generationId: string; retainedBytes: number }>()
    const build = vi.fn((request: { generationId: string }) =>
      buildResult.promise.then((result) => ({ ...result, generationId: request.generationId }))
    )
    const authorize = vi.fn(async () => OWNER.authorizedCanonicalRoot)
    const service = new WorkspacePathIndexService({
      authorize,
      build,
      query: async ({ identity: requestIdentity }) =>
        createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: ['src/target.ts'],
          totalCount: 1,
          generationId: 'generation'
        })
    })
    const args = {
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 512,
      correlationId: '123e4567-e89b-42d3-a456-426614174020'
    }
    await expect(service.ensure(args)).resolves.toMatchObject({ ready: false, reason: 'building' })
    await expect(service.ensure(args)).resolves.toMatchObject({ ready: false, reason: 'building' })
    buildResult.resolve({ generationId: 'generation', retainedBytes: 64 })
    await settleBuild()
    const ready = await service.ensure(args)
    expect(ready.ready).toBe(true)
    expect(build).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledTimes(3)
    await expect(
      service.search({
        identity: identity(),
        ...args
      })
    ).resolves.toMatchObject({
      ready: true,
      response: { count: { value: 1, provenance: 'exact-snapshot' } }
    })
    service.dispose()
  })

  it('keeps one-generation last-known rows while reconciling then restores exact freshness', async () => {
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build: async (request) => ({ generationId: request.generationId, retainedBytes: 64 }),
      query: async ({ identity: requestIdentity }) =>
        createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: ['src/target.ts'],
          totalCount: 1,
          generationId: requestIdentity.generationId ?? 'generation'
        }),
      applyDelta: async (request) => ({
        generationId: request.generationId,
        retainedBytes: 64,
        deltaPathCount: request.mutations.length,
        deltaBytes: 128,
        compacted: false
      })
    })
    const args = {
      identity: identity(),
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 512,
      correlationId: '123e4567-e89b-42d3-a456-426614174044'
    }
    await service.search(args)
    await settleBuild()
    service.beginReconciliation(OWNER, 1)
    await expect(
      service.search({ ...args, identity: identity(OWNER, 'window-1', 2) })
    ).resolves.toMatchObject({
      ready: true,
      response: {
        state: { freshness: 'reconciling', countProvenance: 'last-known' },
        count: { value: 1, provenance: 'last-known' }
      }
    })
    await expect(
      service.applyDelta(
        OWNER,
        [{ type: 'add', path: 'src/new-target.ts', pathSet: 'included' }],
        '123e4567-e89b-42d3-a456-426614174045'
      )
    ).resolves.toBe(true)
    await expect(
      service.search({ ...args, identity: identity(OWNER, 'window-1', 3) })
    ).resolves.toMatchObject({
      ready: true,
      response: {
        state: { freshness: 'no-known-gap', countProvenance: 'exact-snapshot' },
        count: { value: 1, provenance: 'exact-snapshot' }
      }
    })
    service.dispose()
  })

  it('buffers build-time events and replays them onto the published generation', async () => {
    const building = deferred<{ generationId: string; retainedBytes: number }>()
    const applyDelta = vi.fn(async (request: { generationId: string }) => ({
      generationId: request.generationId,
      retainedBytes: 96,
      deltaPathCount: 1,
      deltaBytes: 64,
      compacted: false
    }))
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build: vi.fn((request: { generationId: string }) =>
        building.promise.then(() => ({ generationId: request.generationId, retainedBytes: 64 }))
      ),
      applyDelta,
      query: async ({ identity: requestIdentity }) =>
        createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: ['src/created-during-build.ts'],
          totalCount: 1,
          generationId: requestIdentity.generationId ?? 'published'
        })
    })
    const args = {
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 512,
      correlationId: '123e4567-e89b-42d3-a456-426614174046'
    }
    await expect(service.ensure(args)).resolves.toMatchObject({ ready: false, reason: 'building' })
    service.beginReconciliation(OWNER, 1)
    await expect(
      service.applyDelta(
        OWNER,
        [{ type: 'add', path: 'src/created-during-build.ts', pathSet: 'included' }],
        'watcher-reconcile-1'
      )
    ).resolves.toBe(true)
    building.resolve({ generationId: 'ignored-request-id', retainedBytes: 64 })
    await settleBuild()
    await settleBuild()
    expect(applyDelta).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGenerationId: expect.any(String),
        mutations: [{ type: 'add', path: 'src/created-during-build.ts', pathSet: 'included' }]
      })
    )
    await expect(service.ensure(args)).resolves.toMatchObject({ ready: true })
    service.dispose()
  })

  it('keeps a lost-event build provisional after the bounded replay buffer overflows', async () => {
    const building = deferred<{ generationId: string; retainedBytes: number }>()
    const retryBuilding = deferred<{ generationId: string; retainedBytes: number }>()
    let buildCount = 0
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build: vi.fn((request: { generationId: string }) => {
        buildCount += 1
        const result = buildCount === 1 ? building.promise : retryBuilding.promise
        return result.then(() => ({ generationId: request.generationId, retainedBytes: 64 }))
      }),
      query: async ({ identity: requestIdentity }) =>
        createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: ['src/last-known-target.ts'],
          totalCount: 1,
          generationId: requestIdentity.generationId ?? 'last-known'
        })
    })
    const args = {
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 512,
      correlationId: '123e4567-e89b-42d3-a456-426614174047'
    }
    await service.ensure(args)
    service.beginReconciliation(OWNER, 1)
    let accepted = true
    for (let batch = 0; batch < 5; batch += 1) {
      const mutations = Array.from({ length: 256 }, (_, index) => ({
        type: 'add' as const,
        path: `src/storm-${batch}-${index}.ts`,
        pathSet: 'included' as const
      }))
      accepted = await service.applyDelta(OWNER, mutations, `storm-${batch}`)
    }
    expect(accepted).toBe(false)
    building.resolve({ generationId: 'unused', retainedBytes: 64 })
    await settleBuild()
    await settleBuild()
    const stale = await service.search({
      identity: identity(OWNER, 'window-1', 9),
      ...args
    })
    expect(stale).toMatchObject({
      ready: true,
      response: {
        state: { freshness: 'dirty', countProvenance: 'last-known' },
        count: { value: 1, provenance: 'last-known' }
      }
    })
    service.dispose()
  })

  it('serves the requested first scope while an over-budget second scope degrades', async () => {
    const finishing = deferred<{
      generationId: string
      retainedBytes: number
      degradationReason: string
    }>()
    const build = vi.fn(
      (request: {
        generationId: string
        onScopePublished: (generationId: string, retainedBytes: number, complete: boolean) => void
      }) => {
        request.onScopePublished(request.generationId, 64, false)
        return finishing.promise
      }
    )
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build,
      query: async ({ identity: requestIdentity }) =>
        createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: ['src/visible-target.ts'],
          totalCount: 1,
          generationId: requestIdentity.generationId ?? 'requested-scope'
        })
    })
    const includedArgs = {
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 128,
      firstScope: 'included' as const,
      correlationId: '123e4567-e89b-42d3-a456-426614174043'
    }
    await expect(service.ensure(includedArgs)).resolves.toMatchObject({
      ready: false,
      reason: 'building'
    })
    await expect(service.ensure(includedArgs)).resolves.toMatchObject({
      ready: true,
      generationId: expect.any(String)
    })
    await expect(service.ensure({ ...includedArgs, firstScope: 'all' })).resolves.toMatchObject({
      ready: false,
      reason: 'building'
    })
    finishing.resolve({
      generationId: 'partial-generation',
      retainedBytes: 64,
      degradationReason: 'over-budget'
    })
    await settleBuild()
    await expect(service.ensure(includedArgs)).resolves.toMatchObject({ ready: true })
    await expect(service.ensure({ ...includedArgs, firstScope: 'all' })).resolves.toMatchObject({
      ready: false,
      reason: 'over-budget'
    })
    expect(build).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('keeps one shared entry while two windows hold independent leases', async () => {
    const build = vi.fn(async (request: { generationId: string }) => ({
      generationId: request.generationId,
      retainedBytes: 64
    }))
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build,
      query: async ({ identity: requestIdentity }) =>
        createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: ['src/target.ts'],
          totalCount: 1,
          generationId: requestIdentity.generationId ?? 'generation'
        })
    })
    const firstLease = await service.acquireLease({
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 512,
      correlationId: '123e4567-e89b-42d3-a456-426614174044'
    })
    const secondLease = await service.acquireLease({
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 512,
      correlationId: '123e4567-e89b-42d3-a456-426614174045'
    })
    expect(firstLease).not.toBeNull()
    expect(secondLease).not.toBeNull()
    expect(secondLease).not.toBe(firstLease)
    await settleBuild()
    if (firstLease) {
      service.releaseLease(firstLease)
    }
    await expect(
      service.ensure({
        owner: OWNER,
        listingPolicyVersion: 'listing-v1',
        foldVersion: 'fold-v1',
        buildReservationBytes: 512,
        correlationId: '123e4567-e89b-42d3-a456-426614174046'
      })
    ).resolves.toMatchObject({ ready: true })
    expect(build).toHaveBeenCalledTimes(1)
    if (secondLease) {
      service.releaseLease(secondLease)
    }
    service.dispose()
  })

  it('keeps a released root for reacquisition and evicts the least recently used root', async () => {
    const build = vi.fn(async (request) => ({
      generationId: request.generationId,
      retainedBytes: 64
    }))
    const dropped: string[] = []
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build,
      query: async ({ identity: requestIdentity }) =>
        createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: [],
          totalCount: 0,
          generationId: 'generation'
        }),
      disposeGeneration: (key) => dropped.push(key),
      maxRetainedRoots: 1
    })
    const lease = await service.acquireLease({
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 512,
      correlationId: '123e4567-e89b-42d3-a456-426614174021'
    })
    expect(lease).toBeTruthy()
    if (lease) {
      service.releaseLease(lease)
    }
    await settleBuild()
    const nextOwner = { ...OWNER, authorizedCanonicalRoot: '/workspace/b' }
    await service.ensure({
      owner: nextOwner,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 512,
      correlationId: '123e4567-e89b-42d3-a456-426614174022'
    })
    await settleBuild()
    expect(dropped).toHaveLength(1)
    service.dispose()
  })

  it('prevents a revoked build from publishing into its replacement entry', async () => {
    const first = deferred<{ generationId: string; retainedBytes: number }>()
    const build = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (request: { generationId: string }) => ({
        generationId: request.generationId,
        retainedBytes: 32
      }))
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build,
      query: async ({ identity: requestIdentity }) =>
        createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: [],
          totalCount: 0,
          generationId: 'replacement'
        })
    })
    const args = {
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 512,
      correlationId: '123e4567-e89b-42d3-a456-426614174023'
    }
    await service.ensure(args)
    await service.revoke(OWNER)
    const signal = build.mock.calls[0]?.[0].signal
    expect(signal?.aborted).toBe(true)
    await service.ensure(args)
    first.resolve({ generationId: 'stale', retainedBytes: 32 })
    await settleBuild()
    await settleBuild()
    expect(await service.ensure(args)).toMatchObject({ ready: true })
    service.dispose()
  })
})
