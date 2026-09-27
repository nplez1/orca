import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { FILE_METHODS } from './files'
import { remoteRpcContentBudget } from '../../../../shared/remote-rpc-content-budget'
import {
  RUNTIME_PROTOCOL_VERSION,
  WORKSPACE_PATH_SEARCH_NAME_FILTER_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY } from '../../../../shared/workspace-path-search-contract'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('file path search RPC method', () => {
  it('advertises the negotiated path-search descriptor without changing protocol version', () => {
    const status = new OrcaRuntimeService().getStatus()
    expect(status.runtimeProtocolVersion).toBe(RUNTIME_PROTOCOL_VERSION)
    expect(status.capabilities).toContain(WORKSPACE_PATH_SEARCH_NAME_FILTER_RUNTIME_CAPABILITY)
    expect(
      status.pathSearchCapabilities?.[WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY]
    ).toMatchObject({
      matcherVersion: 1,
      supportedScopes: ['included', 'all'],
      supportsDotfileVisibility: true,
      supportsIgnoredFileVisibility: true,
      supportsExcludePathSegments: true,
      maxPagePaths: 5_000,
      freshnessMetadata: true
    })
  })

  it('returns a bounded server-side result for mobile autocomplete', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      searchMobileFilePaths: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        rootPath: '/repo',
        files: [{ relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' }],
        totalCount: 1,
        truncated: false
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'files.searchPaths',
      params: { worktree: 'id:wt-1', query: 'app', limit: 8 }
    }

    const response = await dispatcher.dispatch(request)

    expect(runtime.searchMobileFilePaths).toHaveBeenCalledWith('id:wt-1', 'app', 8)
    expect(response).toMatchObject({
      ok: true,
      result: { files: [{ relativePath: 'src/app.ts' }] }
    })
  })

  it('routes desktop Quick Open searches with exclusions and cancellation', async () => {
    const searchQuickOpenFilePaths = vi.fn().mockResolvedValue({
      worktree: 'wt-1',
      rootPath: '/repo',
      files: [{ relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' }],
      totalCount: 1,
      truncated: false
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      searchQuickOpenFilePaths
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const controller = new AbortController()

    const response = await dispatcher.dispatch(
      {
        id: 'req-quick-open',
        authToken: 'tok',
        method: 'files.searchPaths',
        params: {
          worktree: 'id:wt-1',
          query: 'app',
          limit: 8,
          excludePaths: ['/repo/nested'],
          mode: 'quick-open'
        }
      },
      { signal: controller.signal }
    )

    expect(searchQuickOpenFilePaths).toHaveBeenCalledWith(
      'id:wt-1',
      'app',
      8,
      ['/repo/nested'],
      controller.signal
    )
    expect(response).toMatchObject({ ok: true, result: { quickOpenSearchVersion: 1 } })
  })

  it('routes negotiated Explorer name-filter searches with bounded scope and cancellation', async () => {
    const controller = new AbortController()
    const runtime = new OrcaRuntimeService()
    const searchWorkspacePathNameFilter = vi
      .spyOn(runtime, 'searchWorkspacePathNameFilter')
      .mockResolvedValue({
        requestIdentity: {
          query: 'src app',
          consumer: { consumerId: 'query-1', sequence: 1 },
          owner: {
            executionHost: { provider: 'runtime', incarnationId: 'runtime-1' },
            authorizedCanonicalRoot: '/repo'
          },
          generationId: null,
          mode: 'name-filter',
          scope: {
            pathSet: 'all',
            includeDotfiles: false,
            includeIgnoredFiles: true,
            excludePathSegments: [['nested']]
          },
          pageBudget: { maxPaths: 5_000, maxSerializedBytes: 100_000 }
        },
        generationId: 'runtime-live-1',
        scopeFingerprint:
          '{"pathSet":"all","includeDotfiles":false,"includeIgnoredFiles":true,"excludePathSegments":[["nested"]]}',
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
        count: { value: 4, provenance: 'exact-snapshot' }
      })
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const response = await dispatcher.dispatch(
      {
        id: 'req-name-filter',
        authToken: 'tok',
        method: 'files.searchPaths',
        params: {
          worktree: 'id:wt-1',
          query: 'src app',
          limit: 5_000,
          excludePaths: ['/repo/nested'],
          mode: 'name-filter',
          scope: {
            pathSet: 'all',
            includeDotfiles: false,
            includeIgnoredFiles: true,
            excludePathSegments: [['nested']]
          },
          maxPageSerializedBytes: 100_000,
          correlationId: 'query-1'
        }
      },
      { signal: controller.signal, clientKind: 'runtime' }
    )

    expect(searchWorkspacePathNameFilter).toHaveBeenCalledWith('id:wt-1', {
      query: 'src app',
      limit: 5_000,
      excludePaths: ['/repo/nested'],
      scope: {
        pathSet: 'all',
        includeDotfiles: false,
        includeIgnoredFiles: true,
        excludePathSegments: [['nested']]
      },
      maxPageSerializedBytes: 100_000,
      correlationId: 'query-1',
      signal: controller.signal,
      maxContentBytes: remoteRpcContentBudget('req-name-filter')
    })
    expect(response).toMatchObject({
      ok: true,
      result: {
        state: { countProvenance: 'exact-snapshot' },
        count: { value: 4, provenance: 'exact-snapshot' }
      }
    })
  })

  it('keeps the legacy 32-row schema closed to unnegotiated modes and limits', async () => {
    const runtime = new OrcaRuntimeService()
    const searchQuickOpenFilePaths = vi
      .spyOn(runtime, 'searchQuickOpenFilePaths')
      .mockResolvedValue({
        worktree: 'wt-1',
        rootPath: '/repo',
        files: [],
        totalCount: 0,
        truncated: false
      })
    const searchWorkspacePathNameFilter = vi.spyOn(runtime, 'searchWorkspacePathNameFilter')
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch({
      id: 'req-old-limit',
      authToken: 'tok',
      method: 'files.searchPaths',
      params: {
        worktree: 'id:wt-1',
        query: 'src app',
        limit: 5_000,
        mode: 'quick-open'
      }
    })

    expect(response).toMatchObject({ ok: false })
    expect(searchQuickOpenFilePaths).not.toHaveBeenCalled()
    expect(searchWorkspacePathNameFilter).not.toHaveBeenCalled()
  })

  it('keeps the complete paired Quick Open reply within its content budget', async () => {
    const searchQuickOpenFilePaths = vi.fn().mockResolvedValue({
      worktree: 'wt-1',
      rootPath: '/repo',
      files: Array.from({ length: 32 }, (_, index) => ({
        relativePath: `${'x'.repeat(170_000)}-${index}.ts`,
        basename: `${index}.ts`,
        kind: 'text' as const
      })),
      totalCount: 32,
      truncated: false
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      searchQuickOpenFilePaths
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const id = 'req-bounded-quick-open'
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      {
        id,
        authToken: 'tok',
        method: 'files.searchPaths',
        params: { worktree: 'id:wt-1', query: 'x', limit: 32, mode: 'quick-open' }
      },
      (response) => replies.push(response),
      { clientKind: 'runtime' }
    )

    const response = JSON.parse(replies.at(-1)!) as {
      ok: boolean
      result: { files: unknown[]; truncated: boolean }
    }
    expect(response.ok).toBe(true)
    expect(response.result.files.length).toBeLessThan(32)
    expect(response.result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(response.result), 'utf8')).toBeLessThanOrEqual(
      remoteRpcContentBudget(id)
    )
  })
})
