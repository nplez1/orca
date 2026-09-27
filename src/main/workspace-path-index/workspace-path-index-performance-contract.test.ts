import { describe, expect, it, vi } from 'vitest'
import { createCompleteWorkspacePathSearchResponse } from '../../shared/workspace-path-search-response'
import type { WorkspacePathSearchFenceIdentity } from '../../shared/workspace-path-search-contract'
import { WorkspacePathIndexService } from './workspace-path-index-service'
import { WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES } from './workspace-path-index-build-budget'
import {
  WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES,
  WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
} from '../../shared/__fixtures__/workspace-path-memory-measurement'
import {
  runWorkspacePathIndexIfEnabled,
  WORKSPACE_PATH_INDEX_DISABLE_ENV
} from './workspace-path-index-feature-switch'

const spawnProcess = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: spawnProcess
}))

const IDENTITY: WorkspacePathSearchFenceIdentity = {
  query: 'target',
  consumer: { consumerId: 'performance-window', sequence: 1 },
  owner: {
    executionHost: { provider: 'local', incarnationId: 'performance-host' },
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
  pageBudget: { maxPaths: 10, maxSerializedBytes: 10_000 }
}

describe('workspace path index structural performance contracts', () => {
  it('does not warm, query, or launch index work when the kill switch is set', async () => {
    spawnProcess.mockClear()
    const build = vi.fn()
    const query = vi.fn()
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build,
      query
    })
    const result = await runWorkspacePathIndexIfEnabled(
      () =>
        service.search({
          identity: IDENTITY,
          listingPolicyVersion: 'listing-v1',
          foldVersion: 'fold-v1',
          buildReservationBytes: 128,
          correlationId: 'disabled-index-query'
        }),
      { [WORKSPACE_PATH_INDEX_DISABLE_ENV]: '1' }
    )

    expect(result).toEqual({ enabled: false })
    expect(build).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(spawnProcess).not.toHaveBeenCalled()
    service.dispose()
  })

  it('reuses a warm generation without discovery or subprocess launches', async () => {
    const rgInvocation = vi.fn()
    const build = vi.fn(async (request: { generationId: string }) => {
      rgInvocation()
      return { generationId: request.generationId, retainedBytes: 64 }
    })
    const query = vi.fn(async ({ identity }: { identity: WorkspacePathSearchFenceIdentity }) =>
      createCompleteWorkspacePathSearchResponse({
        requestIdentity: identity,
        paths: ['src/target.ts'],
        totalCount: 1,
        generationId: identity.generationId ?? 'generation'
      })
    )
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build,
      query
    })
    const args = {
      identity: IDENTITY,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 128,
      correlationId: '123e4567-e89b-42d3-a456-426614174041'
    }
    await service.search(args)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(
      service.search({
        ...args,
        identity: { ...IDENTITY, consumer: { consumerId: 'performance-window', sequence: 2 } }
      })
    ).resolves.toMatchObject({ ready: true })
    expect(build).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
    expect(rgInvocation).toHaveBeenCalledTimes(1)
    expect(spawnProcess).not.toHaveBeenCalled()
    service.dispose()
  })

  it('bounds catalog builds by the host build-peak allowance, not the root retained budget', () => {
    // Why: binding the builder to the 256 MiB root budget spilled ~300-400k-path roots whose retained catalog fits it.
    expect(WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES).toBe(
      WORKSPACE_PATH_INDEX_BUILD_PEAK_RESERVATION_BYTES
    )
    expect(WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES).toBeGreaterThan(
      WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
    )
  })
})
