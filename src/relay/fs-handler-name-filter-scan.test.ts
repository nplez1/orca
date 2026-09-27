import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listFilesWithRg } from './fs-handler-list-files'
import { searchNameFilterPathsWithRg } from './fs-handler-name-filter-scan'
import type { WorkspacePathSearchFenceIdentity } from '../shared/workspace-path-search-contract'

vi.mock('./fs-handler-list-files', () => ({ listFilesWithRg: vi.fn() }))

const listFiles = vi.mocked(listFilesWithRg)

function identity(): WorkspacePathSearchFenceIdentity {
  return {
    query: 'src app',
    consumer: { consumerId: 'consumer-1', sequence: 1 },
    owner: {
      executionHost: { provider: 'ssh', incarnationId: 'host-1' },
      authorizedCanonicalRoot: '/repo'
    },
    generationId: null,
    mode: 'name-filter',
    scope: {
      pathSet: 'included',
      includeDotfiles: false,
      includeIgnoredFiles: false,
      excludePathSegments: [['nested', 'repo']]
    },
    pageBudget: { maxPaths: 32, maxSerializedBytes: 512_000 }
  }
}

describe('relay name-filter scan adapter', () => {
  beforeEach(() => listFiles.mockReset())

  it('uses the shared substring matcher mode with the exact requested scope and cancellation signal', async () => {
    const controller = new AbortController()
    listFiles.mockImplementationOnce(async (_root, _exclude, options) => {
      options?.onSearchResult?.({ paths: ['src/app.ts'], totalCount: 12 }, true)
      return ['src/app.ts']
    })

    await expect(
      searchNameFilterPathsWithRg('/repo', identity(), controller.signal)
    ).resolves.toEqual({
      paths: ['src/app.ts'],
      totalCount: 12,
      complete: true
    })
    expect(listFiles).toHaveBeenCalledWith('/repo', ['nested/repo'], {
      signal: controller.signal,
      maxResults: 32,
      searchQuery: 'src app',
      searchMode: 'name-filter',
      includeIgnoredFiles: false,
      includeDotfiles: false,
      onSearchResult: expect.any(Function)
    })
  })

  it('rejects malformed path exclusions before invoking ripgrep', async () => {
    const invalid = identity()
    invalid.scope.excludePathSegments = [['..']]
    await expect(searchNameFilterPathsWithRg('/repo', invalid)).rejects.toThrow(
      'normalized path segments'
    )
    expect(listFiles).not.toHaveBeenCalled()
  })
})
