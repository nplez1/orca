import { describe, expect, it, vi } from 'vitest'
import { RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR } from '../../shared/workspace-path-search-capability'

const { searchQuickOpenFilePathsMock } = vi.hoisted(() => ({
  searchQuickOpenFilePathsMock: vi.fn()
}))

vi.mock('../ipc/filesystem-search-file-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof FilesystemPathSearchModule>()),
  searchQuickOpenFilePaths: searchQuickOpenFilePathsMock
}))
import type {
  WorkspacePathSearchRequest,
  WorkspacePathSearchResponse,
  WorkspacePathSearchScopeDescriptor
} from '../../shared/workspace-path-search-contract'
import { runtimeFileRouteForTarget } from './runtime-file-command-target'
import { getSshFilesystemProviderMock } from './orca-runtime-files-mock-registry'
import type * as FilesystemPathSearchModule from '../ipc/filesystem-search-file-paths'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'

vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./orca-runtime-files-mock-registry')).sshFilesystemDispatchMock
)

function scope(): WorkspacePathSearchScopeDescriptor {
  return {
    pathSet: 'included',
    includeDotfiles: true,
    includeIgnoredFiles: false,
    excludePathSegments: [['nested']]
  }
}

function exactResponse(request: WorkspacePathSearchRequest): WorkspacePathSearchResponse {
  return {
    requestIdentity: request.identity,
    generationId: 'relay-live-1',
    scopeFingerprint: JSON.stringify(request.identity.scope),
    scopeRuleVersion: 'live-path-search-v1',
    rows: [{ relativePath: 'src/application.ts' }],
    rowClassificationFlags: [0],
    retainedCount: 1,
    state: {
      coverage: 'complete',
      freshness: 'no-known-gap',
      countProvenance: 'exact-snapshot',
      searchComplete: true
    },
    count: { value: 5, provenance: 'exact-snapshot' }
  }
}

describe('runtime forwarding of negotiated workspace path search', () => {
  useRuntimeFileCommandsLifecycle()

  it('forwards the complete fence and cancellation to a capable SSH relay', async () => {
    const controller = new AbortController()
    const searchWorkspacePathNameFilter = vi.fn(async (_root, request) => exactResponse(request))
    const workspacePathSearchCapability = vi.fn(async () => ({
      ...RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR,
      maxPagePaths: 32,
      maxPageSerializedBytes: 400_000
    }))
    const provider = { searchWorkspacePathNameFilter, workspacePathSearchCapability }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    expect(runtimeFileRouteForTarget({ executionHostId: 'ssh:ssh-1' })).toMatchObject({
      kind: 'ssh',
      provider
    })
    const { commands } = createRuntimeFileCommands({
      resolveRuntimeFileTarget: vi.fn(async () => ({
        worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
        executionHostId: 'ssh:ssh-1'
      }))
    })

    await expect(
      commands.searchWorkspacePathNameFilter('id:wt-1', {
        query: 'src app',
        limit: 5_000,
        excludePaths: ['/repo/nested'],
        scope: scope(),
        maxPageSerializedBytes: 400_000,
        correlationId: 'query-1',
        signal: controller.signal
      })
    ).resolves.toMatchObject({
      count: { value: 5, provenance: 'exact-snapshot' },
      state: { countProvenance: 'exact-snapshot' }
    })

    expect(searchWorkspacePathNameFilter).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        correlationId: 'query-1',
        identity: expect.objectContaining({
          query: 'src app',
          mode: 'name-filter',
          scope: scope(),
          pageBudget: { maxPaths: 32, maxSerializedBytes: 400_000 }
        })
      }),
      { signal: controller.signal }
    )
  })

  it('applies hidden-dotfile scope on a local runtime host', async () => {
    searchQuickOpenFilePathsMock.mockResolvedValue({
      paths: ['src/target.ts'],
      totalCount: 1,
      truncated: false
    })
    const hiddenDotfileScope = {
      ...scope(),
      includeDotfiles: false,
      excludePathSegments: []
    }
    const { commands } = createRuntimeFileCommands({
      resolveRuntimeFileTarget: vi.fn(async () => ({
        worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
        executionHostId: 'local'
      }))
    })

    await expect(
      commands.searchWorkspacePathNameFilter('id:wt-1', {
        query: 'target',
        limit: 32,
        scope: hiddenDotfileScope,
        maxPageSerializedBytes: 400_000,
        correlationId: 'hidden-dotfiles-query'
      })
    ).resolves.toMatchObject({
      requestIdentity: { scope: hiddenDotfileScope },
      rows: [{ relativePath: 'src/target.ts' }],
      count: { value: 1, provenance: 'exact-snapshot' }
    })

    expect(searchQuickOpenFilePathsMock).toHaveBeenCalledWith(
      '/repo',
      expect.anything(),
      expect.objectContaining({ includeDotfiles: false })
    )
  })

  it('returns a bounded legacy recheck as partial when the nested relay lacks capability', async () => {
    const listFiles = vi
      .fn()
      .mockResolvedValue(['src/application.ts', 'src/other.ts', 'lib/app.ts'])
    getSshFilesystemProviderMock.mockReturnValue({
      searchWorkspacePathNameFilter: vi.fn().mockResolvedValue(null),
      listFiles
    })
    const { commands } = createRuntimeFileCommands({
      resolveRuntimeFileTarget: vi.fn(async () => ({
        worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
        executionHostId: 'ssh:ssh-1'
      }))
    })

    await expect(
      commands.searchWorkspacePathNameFilter('id:wt-1', {
        query: 'src app',
        limit: 32,
        excludePaths: ['/repo/nested'],
        scope: scope(),
        maxPageSerializedBytes: 400_000,
        correlationId: 'legacy-query'
      })
    ).resolves.toMatchObject({
      rows: [],
      count: { value: null, provenance: 'legacy' },
      state: { coverage: 'partial', searchComplete: false },
      degradationReason: 'classification-pending'
    })
    expect(listFiles).not.toHaveBeenCalled()
  })
})
