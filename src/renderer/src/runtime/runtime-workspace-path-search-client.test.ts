import { describe, expect, it } from 'vitest'
import { searchRuntimeFilePaths } from './runtime-file-search-client'
import {
  fsSearch,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'
import {
  RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR,
  WORKSPACE_PATH_SEARCH_CAPABILITY_DOCUMENT_KEY
} from '../../../shared/workspace-path-search-capability'
import { WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY } from '../../../shared/workspace-path-search-contract'
import type { WorkspacePathSearchResponse } from '../../../shared/workspace-path-search-contract'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

installRuntimeFileClientEnvironment()

function status(capable: boolean, runtimeId = 'runtime-1', supportsDotfileVisibility = true) {
  return {
    id: 'status',
    ok: true,
    result: {
      runtimeId,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities: capable ? [WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY] : [],
      pathSearchCapabilities: capable
        ? {
            [WORKSPACE_PATH_SEARCH_CAPABILITY_DOCUMENT_KEY]: {
              ...RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR,
              supportsDotfileVisibility
            }
          }
        : {}
    },
    _meta: { runtimeId }
  }
}

function exactReply(
  consumerId = 'query-1',
  maxPaths = 5_000,
  maxSerializedBytes = RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR.maxPageSerializedBytes,
  includeDotfiles = true
): WorkspacePathSearchResponse {
  const scope = {
    pathSet: 'all' as const,
    includeDotfiles,
    includeIgnoredFiles: true,
    excludePathSegments: []
  }
  return {
    requestIdentity: {
      query: 'src app',
      consumer: { consumerId, sequence: 1 },
      owner: {
        executionHost: { provider: 'ssh', incarnationId: 'ssh-generation-1' },
        authorizedCanonicalRoot: '/remote/repo'
      },
      generationId: null,
      mode: 'name-filter',
      scope,
      pageBudget: {
        maxPaths,
        maxSerializedBytes
      }
    },
    generationId: 'relay-live-1',
    scopeFingerprint: JSON.stringify(scope),
    scopeRuleVersion: 'live-path-search-v1',
    rows: [{ relativePath: 'src/app.ts' }],
    rowClassificationFlags: [0],
    retainedCount: 1,
    state: {
      coverage: 'complete',
      freshness: 'no-known-gap',
      countProvenance: 'exact-snapshot',
      searchComplete: true
    },
    count: { value: 9, provenance: 'exact-snapshot' }
  }
}

function installStatus(
  capable: boolean,
  runtimeId = 'runtime-1',
  supportsDotfileVisibility = true
): void {
  runtimeEnvironmentTransportCall.mockImplementation((request) =>
    request.method === 'status.get'
      ? Promise.resolve(status(capable, runtimeId, supportsDotfileVisibility))
      : runtimeEnvironmentCall(request)
  )
}

function context(environmentId = 'env-1') {
  return {
    settings: { activeRuntimeEnvironmentId: environmentId },
    worktreeId: 'wt-1',
    worktreePath: '/remote/repo'
  }
}

describe('runtime workspace name-filter search', () => {
  it('sends Explorer limits only after the peer advertises a valid descriptor', async () => {
    installStatus(true)
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'search-1',
      ok: true,
      result: exactReply(),
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      searchRuntimeFilePaths(context(), {
        query: 'src app',
        limit: 5_000,
        mode: 'name-filter',
        includeIgnoredFiles: true,
        correlationId: 'query-1'
      })
    ).resolves.toMatchObject({
      files: ['src/app.ts'],
      totalCount: 9,
      truncated: true,
      workspacePathSearch: { count: { provenance: 'exact-snapshot' } }
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'files.searchPaths',
        expectedEnvironmentRuntimeId: 'runtime-1',
        params: expect.objectContaining({
          mode: 'name-filter',
          limit: 5_000,
          maxPageSerializedBytes:
            RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR.maxPageSerializedBytes,
          scope: {
            pathSet: 'all',
            includeDotfiles: true,
            includeIgnoredFiles: true,
            excludePathSegments: []
          }
        })
      })
    )
    expect(
      runtimeEnvironmentTransportCall.mock.calls.filter(
        ([request]) => request.method === 'status.get'
      )
    ).toHaveLength(1)
    expect(fsSearch).not.toHaveBeenCalled()
  })

  it('forwards hidden-dotfile scope through a capable runtime peer', async () => {
    installStatus(true)
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'hidden-dotfiles',
      ok: true,
      result: exactReply('hidden-dotfiles-query', 5_000, undefined, false),
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      searchRuntimeFilePaths(context(), {
        query: 'src app',
        limit: 5_000,
        mode: 'name-filter',
        includeDotfiles: false,
        correlationId: 'hidden-dotfiles-query'
      })
    ).resolves.toMatchObject({
      files: ['src/app.ts'],
      totalCount: 9,
      workspacePathSearch: { requestIdentity: { scope: { includeDotfiles: false } } }
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'files.searchPaths',
        params: expect.objectContaining({
          mode: 'name-filter',
          scope: expect.objectContaining({ includeDotfiles: false })
        })
      })
    )
  })

  it('keeps hidden-dotfile scope partial when a runtime peer lacks that capability', async () => {
    installStatus(true, 'runtime-1', false)
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'legacy-dotfiles',
      ok: true,
      result: {
        worktree: 'wt-1',
        rootPath: '/remote/repo',
        files: [
          { relativePath: 'src/.target.ts', basename: '.target.ts', kind: 'text' },
          { relativePath: 'src/target.ts', basename: 'target.ts', kind: 'text' }
        ],
        totalCount: 2,
        truncated: false
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      searchRuntimeFilePaths(context(), {
        query: 'target',
        limit: 32,
        mode: 'name-filter',
        includeDotfiles: false,
        correlationId: 'legacy-dotfiles-query'
      })
    ).resolves.toMatchObject({
      files: ['src/target.ts'],
      totalCount: null,
      truncated: true,
      workspacePathSearch: {
        state: { coverage: 'partial', countProvenance: 'legacy', searchComplete: false },
        count: { value: null, provenance: 'legacy' }
      }
    })

    expect(runtimeEnvironmentCall.mock.calls.map(([request]) => request.method)).toEqual([
      'files.list'
    ])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'files.searchPaths',
        params: expect.objectContaining({
          scope: expect.objectContaining({ includeDotfiles: false })
        })
      })
    )
  })

  it('accepts a peer-retained page smaller than the negotiated client page', async () => {
    installStatus(true)
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'small-page',
      ok: true,
      result: exactReply('small-page-query', 32, 100_000),
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      searchRuntimeFilePaths(context(), {
        query: 'src app',
        limit: 5_000,
        mode: 'name-filter',
        correlationId: 'small-page-query'
      })
    ).resolves.toMatchObject({
      totalCount: 9,
      workspacePathSearch: {
        requestIdentity: { pageBudget: { maxPaths: 32, maxSerializedBytes: 100_000 } },
        retainedCount: 1
      }
    })
  })

  it('uses bounded substring rechecking without sending new fields to a legacy peer', async () => {
    installStatus(false, 'legacy-runtime')
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'list-1',
      ok: true,
      result: {
        worktree: 'wt-1',
        rootPath: '/remote/repo',
        files: [
          { relativePath: 'src/application.ts', basename: 'application.ts', kind: 'text' },
          { relativePath: 'src/other.ts', basename: 'other.ts', kind: 'text' },
          { relativePath: 'lib/app.ts', basename: 'app.ts', kind: 'text' }
        ],
        totalCount: 7_000,
        truncated: true
      },
      _meta: { runtimeId: 'legacy-runtime' }
    })

    await expect(
      searchRuntimeFilePaths(context(), {
        query: 'src app',
        limit: 5_000,
        mode: 'name-filter',
        includeIgnoredFiles: true,
        correlationId: 'legacy-query'
      })
    ).resolves.toMatchObject({
      files: ['src/application.ts'],
      totalCount: null,
      truncated: true,
      workspacePathSearch: {
        state: { coverage: 'partial', countProvenance: 'legacy', searchComplete: false },
        count: { value: null, provenance: 'legacy' }
      }
    })

    expect(runtimeEnvironmentCall.mock.calls.map(([request]) => request.method)).toEqual([
      'files.list'
    ])
    expect(runtimeEnvironmentCall.mock.calls[0]?.[0].params).not.toHaveProperty('mode')
    expect(runtimeEnvironmentCall.mock.calls[0]?.[0].params).not.toHaveProperty('limit', 5_000)
    expect(fsSearch).not.toHaveBeenCalled()
  })

  it('keeps unknown freshness values decodable and downgrades their count authority', async () => {
    installStatus(true)
    const reply = {
      ...exactReply(),
      requestIdentity: {
        ...exactReply().requestIdentity,
        pageBudget: {
          ...exactReply().requestIdentity.pageBudget,
          maxPaths: 32
        }
      },
      state: {
        coverage: 'complete' as const,
        freshness: 'future-freshness-state',
        countProvenance: 'exact-snapshot' as const,
        searchComplete: true as const
      },
      degradationReason: 'future-degradation-reason'
    }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'search-unknown-freshness',
      ok: true,
      result: reply,
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      searchRuntimeFilePaths(context(), {
        query: 'src app',
        limit: 32,
        mode: 'name-filter',
        correlationId: 'query-1'
      })
    ).resolves.toMatchObject({
      totalCount: null,
      truncated: true,
      workspacePathSearch: {
        state: { freshness: 'future-freshness-state', countProvenance: 'last-known' },
        degradationReason: 'future-degradation-reason'
      }
    })
  })

  it('isolates cached capabilities when the runtime pairing generation changes', async () => {
    installStatus(true)
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'generation-a',
        ok: true,
        result: exactReply('generation-a', 32),
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'generation-b',
        ok: true,
        result: exactReply('generation-b', 32),
        _meta: { runtimeId: 'runtime-1' }
      })
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 1 }])
    await searchRuntimeFilePaths(context(), {
      query: 'src app',
      limit: 32,
      mode: 'name-filter',
      correlationId: 'generation-a'
    })

    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 2 }])
    await searchRuntimeFilePaths(context(), {
      query: 'src app',
      limit: 32,
      mode: 'name-filter',
      correlationId: 'generation-b'
    })

    expect(
      runtimeEnvironmentTransportCall.mock.calls.filter(
        ([request]) => request.method === 'status.get'
      )
    ).toHaveLength(2)
  })

  it('validates both remote query limits before probing or searching', async () => {
    await expect(
      searchRuntimeFilePaths(context(), {
        query: 'x'.repeat(257),
        limit: 5_000,
        mode: 'name-filter'
      })
    ).rejects.toThrow('too large or invalid')
    expect(runtimeEnvironmentTransportCall).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(fsSearch).not.toHaveBeenCalled()
  })

  it('does not switch to a client-local search when the runtime is disconnected', async () => {
    runtimeEnvironmentTransportCall.mockRejectedValue(new Error('connection closed'))

    await expect(
      searchRuntimeFilePaths(context(), {
        query: 'src app',
        limit: 5_000,
        mode: 'name-filter'
      })
    ).rejects.toThrow('connection closed')
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(fsSearch).not.toHaveBeenCalled()
  })
})
