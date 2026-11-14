import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchOwnerIdentity
} from '../../shared/workspace-path-search-contract'
import { createCompleteWorkspacePathSearchResponse } from '../../shared/workspace-path-search-response'
import { WorkspacePathIndexService } from './workspace-path-index-service'

const OWNER: WorkspacePathSearchOwnerIdentity = {
  executionHost: { provider: 'local', incarnationId: 'recovery-host' },
  authorizedCanonicalRoot: '/workspace/recovery'
}

function identity(
  owner = OWNER,
  consumerId = 'recovery-window',
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

async function settleBuild(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WorkspacePathIndexService recovery and admission', () => {
  it('drops worker-lost generations and rebuilds after bounded backoff', async () => {
    let queryCount = 0
    const build = vi.fn(async (request: { generationId: string }) => ({
      generationId: request.generationId,
      retainedBytes: 64
    }))
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build,
      retryBackoffMilliseconds: 0,
      query: async ({ identity: requestIdentity }) => {
        queryCount += 1
        if (queryCount === 1) {
          throw new Error('simulated worker crash')
        }
        return createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: ['src/target.ts'],
          totalCount: 1,
          generationId: requestIdentity.generationId ?? 'new-generation'
        })
      }
    })
    const args = {
      identity: identity(OWNER, 'recover-window', 1),
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 512,
      correlationId: '123e4567-e89b-42d3-a456-426614174034'
    }
    await service.search(args)
    await settleBuild()
    await expect(service.search(args)).resolves.toMatchObject({ ready: false, reason: 'failed' })
    await expect(
      service.search({ ...args, identity: identity(OWNER, 'recover-window', 2) })
    ).resolves.toMatchObject({ ready: false, reason: 'building' })
    await settleBuild()
    await expect(
      service.search({ ...args, identity: identity(OWNER, 'recover-window', 3) })
    ).resolves.toMatchObject({ ready: true })
    expect(build).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  // Why (issue #301): every root queries the same worker, but a failed query reset all of them, so
  // one root's lost generation made every other workspace fall back to a main-thread rescan.
  it('resets only the root whose query failed and leaves another root serving its generation', async () => {
    const otherOwner: WorkspacePathSearchOwnerIdentity = {
      executionHost: { provider: 'local', incarnationId: 'recovery-host' },
      authorizedCanonicalRoot: '/workspace/recovery-other'
    }
    const builds: string[] = []
    const build = vi.fn(
      async (request: { owner: WorkspacePathSearchOwnerIdentity; generationId: string }) => {
        builds.push(request.owner.authorizedCanonicalRoot)
        return { generationId: request.generationId, retainedBytes: 48 }
      }
    )
    let failQueryFor: string | null = null
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build,
      retryBackoffMilliseconds: 0,
      query: async ({ identity: requestIdentity }) => {
        if (failQueryFor === requestIdentity.owner.authorizedCanonicalRoot) {
          failQueryFor = null
          throw new Error('Workspace path catalog generation is unavailable')
        }
        return createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: ['src/target.ts'],
          totalCount: 1,
          generationId: requestIdentity.generationId ?? 'missing-generation'
        })
      }
    })
    const search = (
      owner: WorkspacePathSearchOwnerIdentity,
      consumerId: string,
      sequence: number
    ) =>
      service.search({
        identity: identity(owner, consumerId, sequence),
        listingPolicyVersion: 'listing-v1',
        foldVersion: 'fold-v1',
        buildReservationBytes: 256,
        correlationId: '123e4567-e89b-42d3-a456-426614174301'
      })

    await search(OWNER, 'failing-root', 1)
    await settleBuild()
    await expect(search(OWNER, 'failing-root', 2)).resolves.toMatchObject({ ready: true })
    await search(otherOwner, 'healthy-root', 1)
    await settleBuild()
    await expect(search(otherOwner, 'healthy-root', 2)).resolves.toMatchObject({ ready: true })

    failQueryFor = OWNER.authorizedCanonicalRoot
    await expect(search(OWNER, 'failing-root', 3)).resolves.toMatchObject({
      ready: false,
      reason: 'failed'
    })

    await expect(search(otherOwner, 'healthy-root', 3)).resolves.toMatchObject({ ready: true })
    expect(builds).toEqual([OWNER.authorizedCanonicalRoot, otherOwner.authorizedCanonicalRoot])

    await expect(search(OWNER, 'failing-root', 4)).resolves.toMatchObject({
      ready: false,
      reason: 'building'
    })
    await settleBuild()
    await expect(search(OWNER, 'failing-root', 5)).resolves.toMatchObject({ ready: true })
    expect(builds).toEqual([
      OWNER.authorizedCanonicalRoot,
      otherOwner.authorizedCanonicalRoot,
      OWNER.authorizedCanonicalRoot
    ])
    service.dispose()
  })

  // Why (issue #301): a query that loses a race with a newer generation must not drop that generation.
  it('keeps a generation published while the failed query was still in flight', async () => {
    const builds: string[] = []
    let failStaleQuery = false
    let publishNewerGeneration = async (): Promise<void> => {}
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build: async (request) => {
        builds.push(request.owner.authorizedCanonicalRoot)
        return { generationId: request.generationId, retainedBytes: 48 }
      },
      retryBackoffMilliseconds: 0,
      applyDelta: async (request) => ({
        generationId: `${request.expectedGenerationId}:delta`,
        retainedBytes: 64,
        deltaPathCount: 1,
        deltaBytes: 8,
        compacted: false
      }),
      query: async ({ identity: requestIdentity }) => {
        if (failStaleQuery) {
          failStaleQuery = false
          await publishNewerGeneration()
          throw new Error('Workspace path catalog generation is unavailable')
        }
        return createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: ['src/target.ts'],
          totalCount: 1,
          generationId: requestIdentity.generationId ?? 'missing-generation'
        })
      }
    })
    publishNewerGeneration = async () => {
      await service.applyDelta(
        OWNER,
        [{ type: 'add', path: 'src/new.ts', pathSet: 'included' }],
        '123e4567-e89b-42d3-a456-426614174302'
      )
    }
    const search = (sequence: number) =>
      service.search({
        identity: identity(OWNER, 'raced-root', sequence),
        listingPolicyVersion: 'listing-v1',
        foldVersion: 'fold-v1',
        buildReservationBytes: 256,
        correlationId: '123e4567-e89b-42d3-a456-426614174303'
      })

    await search(1)
    await settleBuild()
    await expect(search(2)).resolves.toMatchObject({ ready: true })

    failStaleQuery = true
    await expect(search(3)).resolves.toMatchObject({ ready: false, reason: 'failed' })

    await expect(search(4)).resolves.toMatchObject({ ready: true })
    expect(builds).toEqual([OWNER.authorizedCanonicalRoot])
    service.dispose()
  })

  it('backs off after a worker build failure and retries the same requested scope', async () => {
    // Only Date is faked: the retry backoff compares Date.now(), while settleBuild needs real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    let buildCount = 0
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      retryBackoffMilliseconds: 15,
      build: async (request) => {
        buildCount += 1
        if (buildCount === 1) {
          throw new Error('simulated worker restart')
        }
        return { generationId: request.generationId, retainedBytes: 32 }
      },
      query: async ({ identity: requestIdentity }) =>
        createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: ['src/target.ts'],
          totalCount: 1,
          generationId: requestIdentity.generationId ?? 'recovered'
        })
    })
    const args = {
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 128,
      correlationId: '123e4567-e89b-42d3-a456-426614174042'
    }
    await expect(service.ensure(args)).resolves.toMatchObject({ ready: false, reason: 'building' })
    await settleBuild()
    await expect(service.ensure(args)).resolves.toMatchObject({ ready: false, reason: 'failed' })
    vi.advanceTimersByTime(20)
    await expect(service.ensure(args)).resolves.toMatchObject({ ready: false, reason: 'building' })
    await settleBuild()
    await expect(service.ensure(args)).resolves.toMatchObject({ ready: true })
    expect(buildCount).toBe(2)
    service.dispose()
  })

  it('refuses the one-million-path build visibly before starting work', async () => {
    const build = vi.fn()
    const events: unknown[] = []
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build,
      query: vi.fn(),
      onInstrumentation: (event) => events.push(event)
    })
    const result = await service.ensure({
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 517_371_700,
      correlationId: '123e4567-e89b-42d3-a456-426614174024'
    })
    expect(result).toMatchObject({ ready: false, reason: 'over-budget' })
    expect(build).not.toHaveBeenCalled()
    expect(events).toContainEqual({
      kind: 'cache-miss',
      correlationId: '123e4567-e89b-42d3-a456-426614174024',
      reason: 'over-budget'
    })
    service.dispose()
  })
})
