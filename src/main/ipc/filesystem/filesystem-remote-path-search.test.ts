import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../../providers/ssh-filesystem-dispatch'
import { searchSshWorkspaceNameFilter } from './filesystem-remote-path-search'
import type { IFilesystemProvider } from '../../providers/types'
import type { WorkspacePathSearchResponse } from '../../../shared/workspace-path-search-contract'
import { RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR } from '../../../shared/workspace-path-search-capability'

afterEach(() => {
  unregisterSshFilesystemProvider('ssh-1')
  unregisterSshFilesystemProvider('ssh-old')
  unregisterSshFilesystemProvider('ssh-down')
})

function exactResponse(
  identity: WorkspacePathSearchResponse['requestIdentity']
): WorkspacePathSearchResponse {
  return {
    requestIdentity: identity,
    generationId: 'relay-live-1',
    scopeFingerprint: 'included',
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
    count: { value: 3, provenance: 'exact-snapshot' }
  }
}

function createFilesystemProvider(
  overrides: Partial<
    Pick<
      IFilesystemProvider,
      'listFiles' | 'searchWorkspacePathNameFilter' | 'workspacePathSearchCapability'
    >
  >
): IFilesystemProvider {
  return {
    readDir: async () => [],
    readFile: async () => ({ content: '', isBinary: false }),
    writeFile: async () => {},
    writeFileBase64: async () => {},
    writeFileBase64Chunk: async () => {},
    stat: async () => ({ size: 0, type: 'file', mtime: 0 }),
    deletePath: async () => {},
    createFile: async () => {},
    createDir: async () => {},
    createDirNoClobber: async () => {},
    rename: async () => {},
    renameNoClobber: async () => {},
    copy: async () => {},
    realpath: async (path) => path,
    search: async () => ({ files: [], totalMatches: 0, truncated: false }),
    listFiles: async () => [],
    watch: async () => () => {},
    ...overrides
  }
}

describe('direct SSH workspace path search', () => {
  it('uses the structured SSH route and exposes exact counts only from a complete reply', async () => {
    const searchWorkspacePathNameFilter = vi.fn(async (_root, request) =>
      exactResponse(request.identity)
    )
    const workspacePathSearchCapability = vi.fn(async () => ({
      ...RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR,
      maxPagePaths: 32,
      maxPageSerializedBytes: 100_000
    }))
    const provider = createFilesystemProvider({
      searchWorkspacePathNameFilter,
      workspacePathSearchCapability
    })
    registerSshFilesystemProvider('ssh-1', provider)

    await expect(
      searchSshWorkspaceNameFilter({
        connectionId: 'ssh-1',
        rootPath: '/repo',
        query: 'src app',
        limit: 5_000,
        includeIgnoredFiles: false,
        excludePaths: ['/repo/nested']
      })
    ).resolves.toMatchObject({
      files: ['src/application.ts'],
      totalCount: 3,
      truncated: true,
      workspacePathSearch: { count: { provenance: 'exact-snapshot' } }
    })
    expect(searchWorkspacePathNameFilter).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        identity: {
          query: 'src app',
          consumer: expect.objectContaining({ sequence: 1 }),
          owner: {
            executionHost: { provider: 'ssh', incarnationId: 'ssh-1' },
            authorizedCanonicalRoot: '/repo'
          },
          generationId: null,
          mode: 'name-filter',
          scope: {
            pathSet: 'included',
            includeDotfiles: true,
            includeIgnoredFiles: false,
            excludePathSegments: [['nested']]
          },
          pageBudget: { maxPaths: 32, maxSerializedBytes: 100_000 }
        }
      }),
      { signal: undefined }
    )
  })

  it('rechecks a bounded legacy SSH page but never claims an exact count', async () => {
    const listFiles = vi
      .fn()
      .mockResolvedValue(['src/application.ts', 'src/other.ts', 'lib/app.ts'])
    const provider = createFilesystemProvider({
      searchWorkspacePathNameFilter: vi.fn().mockResolvedValue(null),
      listFiles
    })
    registerSshFilesystemProvider('ssh-old', provider)

    await expect(
      searchSshWorkspaceNameFilter({
        connectionId: 'ssh-old',
        rootPath: '/repo',
        query: 'src app',
        limit: 32
      })
    ).resolves.toMatchObject({
      files: ['src/application.ts'],
      totalCount: null,
      truncated: true,
      workspacePathSearch: {
        state: { coverage: 'partial', countProvenance: 'legacy' },
        count: { value: null, provenance: 'legacy' }
      }
    })
    expect(listFiles).toHaveBeenCalledWith('/repo', {
      excludePaths: undefined,
      maxResults: 20_001,
      signal: undefined
    })
  })

  it('keeps hidden-dotfile scope partial when the SSH peer lacks visibility support', async () => {
    const searchWorkspacePathNameFilter = vi.fn().mockResolvedValue(null)
    const workspacePathSearchCapability = vi.fn().mockResolvedValue({
      ...RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR,
      supportsDotfileVisibility: false
    })
    const listFiles = vi.fn().mockResolvedValue(['src/.target.ts', 'src/target.ts'])
    registerSshFilesystemProvider(
      'ssh-old',
      createFilesystemProvider({
        searchWorkspacePathNameFilter,
        workspacePathSearchCapability,
        listFiles
      })
    )

    await expect(
      searchSshWorkspaceNameFilter({
        connectionId: 'ssh-old',
        rootPath: '/repo',
        query: 'target',
        limit: 32,
        includeDotfiles: false
      })
    ).resolves.toMatchObject({
      files: ['src/target.ts'],
      totalCount: null,
      truncated: true,
      workspacePathSearch: {
        requestIdentity: { scope: { includeDotfiles: false } },
        state: { coverage: 'partial', countProvenance: 'legacy', searchComplete: false },
        count: { value: null, provenance: 'legacy' }
      }
    })

    expect(searchWorkspacePathNameFilter.mock.calls[0]?.[1]).toMatchObject({
      identity: { scope: { includeDotfiles: false } }
    })
    expect(listFiles).toHaveBeenCalled()
  })

  it('fails closed when the SSH provider is unavailable', async () => {
    await expect(
      Promise.resolve().then(() =>
        searchSshWorkspaceNameFilter({
          connectionId: 'ssh-down',
          rootPath: '/repo',
          query: 'src app',
          limit: 32
        })
      )
    ).rejects.toThrow('Remote connection dropped')
  })
})
