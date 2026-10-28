import { beforeEach, describe, expect, it, vi } from 'vitest'

const { searchQuickOpenFilePathsMock } = vi.hoisted(() => ({
  searchQuickOpenFilePathsMock: vi.fn()
}))

vi.mock('../ipc/filesystem/filesystem-search-file-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof FilesystemPathSearchModule>()),
  searchQuickOpenFilePaths: searchQuickOpenFilePathsMock
}))
import type { WorkspacePathSearchScopeDescriptor } from '../../shared/workspace-path-search-contract'
import type * as FilesystemPathSearchModule from '../ipc/filesystem/filesystem-search-file-paths'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'

function scope(): WorkspacePathSearchScopeDescriptor {
  return {
    pathSet: 'included',
    includeDotfiles: true,
    includeIgnoredFiles: false,
    excludePathSegments: [['nested']]
  }
}

describe('runtime forwarding of negotiated workspace path search', () => {
  useRuntimeFileCommandsLifecycle()

  // Why reset between cases: the suite asserts `not.toHaveBeenCalled()` on the local walk, and this
  // config does not clear mocks, so a call carried over from an earlier case would hide a regression.
  beforeEach(() => searchQuickOpenFilePathsMock.mockReset())

  it('answers an SSH route with an unsupported partial response, and installs nothing', async () => {
    // Why: the relay-era provider hook this branch used to call is gone (2026-10-13 sync); an SSH
    // route must degrade the way the client already handles an unsupported host, not throw.
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
        correlationId: 'ssh-query'
      })
    ).resolves.toMatchObject({
      rows: [],
      retainedCount: 0,
      count: { value: null, provenance: 'legacy' },
      state: { coverage: 'partial', searchComplete: false },
      degradationReason: 'unsupported'
    })
    expect(searchQuickOpenFilePathsMock).not.toHaveBeenCalled()
  })

  it('rejects a query that cannot be searched instead of falling through to a local walk', async () => {
    const { commands } = createRuntimeFileCommands({
      resolveRuntimeFileTarget: vi.fn(async () => ({
        worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
        executionHostId: 'local'
      }))
    })

    await expect(
      commands.searchWorkspacePathNameFilter('id:wt-1', {
        query: '   ',
        limit: 32,
        scope: scope(),
        maxPageSerializedBytes: 400_000
      })
    ).rejects.toThrow(/Invalid remote workspace path search query/)
    expect(searchQuickOpenFilePathsMock).not.toHaveBeenCalled()
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
      excludePathSegments: [['nested']]
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
        excludePaths: ['/repo/nested'],
        scope: hiddenDotfileScope,
        maxPageSerializedBytes: 400_000,
        correlationId: 'hidden-dotfiles-query'
      })
    ).resolves.toMatchObject({
      requestIdentity: { scope: hiddenDotfileScope },
      rows: [{ relativePath: 'src/target.ts' }],
      count: { value: 1, provenance: 'exact-snapshot' }
    })

    // Every field the local branch forwards, so a dropped limit, mode, ignored-files or exclusion
    // flag fails here rather than silently narrowing the search.
    expect(searchQuickOpenFilePathsMock).toHaveBeenCalledWith(
      '/repo',
      expect.anything(),
      expect.objectContaining({
        query: 'target',
        limit: 32,
        mode: 'name-filter',
        excludePaths: ['/repo/nested'],
        includeIgnoredFiles: false,
        includeDotfiles: false
      })
    )
  })
})
