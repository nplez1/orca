import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestContext } from './dispatcher'
import { searchNameFilterPathsWithRg } from './fs-handler-name-filter-scan'
import { searchRelayNameFilterPaths } from './fs-handler-name-filter-search'
import { RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR } from '../shared/workspace-path-search-capability'
import type { WorkspacePathSearchRequest } from '../shared/workspace-path-search-contract'

vi.mock('./fs-handler-name-filter-scan', () => ({
  searchNameFilterPathsWithRg: vi.fn()
}))

const scan = vi.mocked(searchNameFilterPathsWithRg)

function request(
  overrides: Partial<WorkspacePathSearchRequest['identity']> = {}
): WorkspacePathSearchRequest {
  return {
    identity: {
      query: 'src app',
      consumer: { consumerId: 'consumer-1', sequence: 2 },
      owner: {
        executionHost: { provider: 'ssh', incarnationId: 'provider-1' },
        authorizedCanonicalRoot: '/remote/repo'
      },
      generationId: null,
      mode: 'name-filter',
      scope: {
        pathSet: 'all',
        includeDotfiles: true,
        includeIgnoredFiles: true,
        excludePathSegments: [['nested', 'repo']]
      },
      pageBudget: {
        maxPaths: 32,
        maxSerializedBytes: RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR.maxPageSerializedBytes
      },
      ...overrides
    },
    correlationId: 'correlation-1'
  }
}

function context(signal = new AbortController().signal, clientId = 5): RequestContext {
  return { clientId, isStale: () => signal.aborted, signal }
}

describe('relay negotiated name-filter search', () => {
  beforeEach(() => {
    scan.mockReset().mockResolvedValue({
      paths: ['src/app.ts', 'nested/repo/src/app.ts'],
      totalCount: 8,
      complete: true
    })
  })

  it('uses the exact matcher result and keeps the count independent of page size', async () => {
    const controller = new AbortController()
    const callContext = context(controller.signal)
    const result = await searchRelayNameFilterPaths(
      { rootPath: '/remote/repo', request: request() },
      callContext
    )

    expect(scan).toHaveBeenCalledWith('/remote/repo', request().identity, controller.signal)
    expect(result).toMatchObject({
      rows: [{ relativePath: 'src/app.ts' }, { relativePath: 'nested/repo/src/app.ts' }],
      retainedCount: 2,
      count: { value: 8, provenance: 'exact-snapshot' },
      state: {
        coverage: 'complete',
        freshness: 'no-known-gap',
        countProvenance: 'exact-snapshot',
        searchComplete: true
      }
    })
    expect(JSON.stringify(result)).toContain('"relativePath"')
  })

  it('labels a permission-limited scan partial instead of claiming an exact total', async () => {
    scan.mockResolvedValueOnce({
      paths: ['src/app.ts'],
      totalCount: 3,
      complete: false
    })
    const result = await searchRelayNameFilterPaths(
      { rootPath: '/remote/repo', request: request() },
      context()
    )

    expect(result).toMatchObject({
      state: { coverage: 'partial', countProvenance: 'legacy', searchComplete: false },
      count: { value: null, provenance: 'legacy' },
      degradationReason: 'interrupted'
    })
  })

  it('refuses unsupported page limits before starting any scan', async () => {
    const oversized = request({
      pageBudget: { maxPaths: 5_001, maxSerializedBytes: 512 }
    })
    await expect(
      searchRelayNameFilterPaths({ rootPath: '/remote/repo', request: oversized }, context())
    ).rejects.toThrow('exceeds the negotiated capability')
    expect(scan).not.toHaveBeenCalled()
  })

  it('keeps two client scan cancellations independent', async () => {
    const firstController = new AbortController()
    const secondController = new AbortController()
    const secondCompletion: {
      finish?: (value: { paths: string[]; totalCount: number; complete: boolean }) => void
    } = {}
    scan
      .mockImplementationOnce(
        (_root, _identity, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('first scan cancelled')), {
              once: true
            })
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            secondCompletion.finish = resolve
          })
      )
    const first = searchRelayNameFilterPaths(
      { rootPath: '/remote/repo', request: request() },
      context(firstController.signal, 1)
    )
    const second = searchRelayNameFilterPaths(
      { rootPath: '/remote/repo', request: request() },
      context(secondController.signal, 2)
    )
    firstController.abort()
    secondCompletion.finish?.({ paths: ['src/app.ts'], totalCount: 1, complete: true })

    await expect(first).rejects.toThrow('first scan cancelled')
    await expect(second).resolves.toMatchObject({
      count: { value: 1, provenance: 'exact-snapshot' }
    })
    expect(secondController.signal.aborted).toBe(false)
  })

  it('rejects overlong remote queries before filesystem work', async () => {
    const oversized = request({ query: 'x'.repeat(257) })
    await expect(
      searchRelayNameFilterPaths({ rootPath: '/remote/repo', request: oversized }, context())
    ).rejects.toThrow('Invalid remote workspace path search query')
    expect(scan).not.toHaveBeenCalled()
  })
})
