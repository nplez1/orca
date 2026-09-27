import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import {
  RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR,
  WORKSPACE_PATH_SEARCH_CAPABILITY_DOCUMENT_KEY
} from '../../../shared/workspace-path-search-capability'
import { WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY } from '../../../shared/workspace-path-search-contract'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

const NameFilterRequestSchema = z.object({
  query: z.string(),
  scope: z.object({
    pathSet: z.literal('all'),
    includeDotfiles: z.literal(true),
    includeIgnoredFiles: z.literal(true),
    excludePathSegments: z.tuple([])
  }),
  correlationId: z.string(),
  limit: z.number(),
  maxPageSerializedBytes: z.number()
})

const worktree = {
  id: 'wt-1',
  repoId: 'repo-1',
  path: '/workspace/repo',
  head: 'abc123',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true,
  displayName: 'repo',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  workspaceStatus: 'todo'
}

describe('paired web workspace path search', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('negotiates before sending the new mode and returns host-authoritative metadata', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'status.get') {
            return Promise.resolve(statusResponse(true))
          }
          if (method === 'repo.list') {
            return Promise.resolve(success({ repos: [{ id: 'repo-1' }] }))
          }
          if (method === 'worktree.detectedList') {
            return Promise.resolve(
              success({ repoId: 'repo-1', authoritative: true, worktrees: [worktree] })
            )
          }
          if (method === 'files.searchPaths') {
            const request = NameFilterRequestSchema.parse(params)
            return Promise.resolve(
              success({
                requestIdentity: {
                  query: request.query,
                  consumer: { consumerId: request.correlationId, sequence: 1 },
                  owner: {
                    executionHost: { provider: 'runtime', incarnationId: 'runtime-1' },
                    authorizedCanonicalRoot: '/workspace/repo'
                  },
                  generationId: null,
                  mode: 'name-filter',
                  scope: request.scope,
                  pageBudget: {
                    maxPaths: request.limit,
                    maxSerializedBytes: request.maxPageSerializedBytes
                  }
                },
                generationId: 'runtime-live-1',
                scopeFingerprint:
                  '{"pathSet":"all","includeDotfiles":true,"includeIgnoredFiles":true,"excludePathSegments":[]}',
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
                count: { value: 6, provenance: 'exact-snapshot' }
              })
            )
          }
          return Promise.resolve(success({}))
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.fs.searchFilePaths({
        rootPath: '/workspace/repo',
        query: 'src app',
        limit: 5_000,
        mode: 'name-filter',
        includeIgnoredFiles: true,
        correlationId: 'web-query-1'
      })
    ).resolves.toMatchObject({ files: ['src/app.ts'], totalCount: 6, truncated: true })
    expect(runtimeCalls.map((call) => call.method)).toContain('status.get')
    expect(runtimeCalls.find((call) => call.method === 'files.searchPaths')?.params).toMatchObject({
      mode: 'name-filter',
      limit: 5_000
    })
  })

  it('cancels the first superseded query through the runtime transport', async () => {
    let requestSignal: AbortSignal | undefined
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(
          method: string,
          _params?: unknown,
          options?: { signal?: AbortSignal }
        ): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'status.get') {
            return Promise.resolve(statusResponse(true))
          }
          if (method === 'repo.list') {
            return Promise.resolve(success({ repos: [{ id: 'repo-1' }] }))
          }
          if (method === 'worktree.detectedList') {
            return Promise.resolve(
              success({ repoId: 'repo-1', authoritative: true, worktrees: [worktree] })
            )
          }
          if (method === 'files.searchPaths') {
            requestSignal = options?.signal
            return new Promise((_resolve, reject) => {
              requestSignal?.addEventListener('abort', () => reject(new Error('query cancelled')), {
                once: true
              })
            })
          }
          return Promise.resolve(success({}))
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const search = globals.window.api.fs.searchFilePaths({
      rootPath: '/workspace/repo',
      query: 'src app',
      limit: 5_000,
      mode: 'name-filter',
      requestToken: 'request-cancel-1'
    })
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    await globals.window.api.fs.cancelListFiles({ requestToken: 'request-cancel-1' })

    await expect(search).rejects.toThrow('query cancelled')
    expect(requestSignal?.aborted).toBe(true)
  })

  it('cancels a superseded query through the runtime transport', async () => {
    let requestSignal: AbortSignal | undefined
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(
          method: string,
          _params?: unknown,
          options?: { signal?: AbortSignal }
        ): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'status.get') {
            return Promise.resolve(statusResponse(true))
          }
          if (method === 'repo.list') {
            return Promise.resolve(success({ repos: [{ id: 'repo-1' }] }))
          }
          if (method === 'worktree.detectedList') {
            return Promise.resolve(
              success({ repoId: 'repo-1', authoritative: true, worktrees: [worktree] })
            )
          }
          if (method === 'files.searchPaths') {
            requestSignal = options?.signal
            return new Promise((_resolve, reject) => {
              requestSignal?.addEventListener('abort', () => reject(new Error('query cancelled')), {
                once: true
              })
            })
          }
          return Promise.resolve(success({}))
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const search = globals.window.api.fs.searchFilePaths({
      rootPath: '/workspace/repo',
      query: 'src app',
      limit: 5_000,
      mode: 'name-filter',
      requestToken: 'request-cancel-1'
    })
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    await globals.window.api.fs.cancelListFiles({ requestToken: 'request-cancel-1' })

    await expect(search).rejects.toThrow('query cancelled')
    expect(requestSignal?.aborted).toBe(true)
  })

  it('uses a bounded partial legacy result without sending the new enum', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'status.get') {
            return Promise.resolve(statusResponse(false))
          }
          if (method === 'repo.list') {
            return Promise.resolve(success({ repos: [{ id: 'repo-1' }] }))
          }
          if (method === 'worktree.detectedList') {
            return Promise.resolve(
              success({ repoId: 'repo-1', authoritative: true, worktrees: [worktree] })
            )
          }
          if (method === 'files.list') {
            return Promise.resolve(
              success({
                worktree: 'wt-1',
                rootPath: '/workspace/repo',
                files: [
                  { relativePath: 'src/application.ts', basename: 'application.ts', kind: 'text' },
                  { relativePath: 'src/other.ts', basename: 'other.ts', kind: 'text' }
                ],
                totalCount: 10_000,
                truncated: true
              })
            )
          }
          return Promise.resolve(success({}))
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.fs.searchFilePaths({
        rootPath: '/workspace/repo',
        query: 'src app',
        limit: 5_000,
        mode: 'name-filter',
        correlationId: 'web-legacy-query'
      })
    ).resolves.toMatchObject({
      files: ['src/application.ts'],
      totalCount: null,
      truncated: true,
      workspacePathSearch: {
        state: { countProvenance: 'legacy', searchComplete: false },
        count: { value: null, provenance: 'legacy' }
      }
    })
    expect(runtimeCalls.map((call) => call.method)).toContain('files.list')
    expect(runtimeCalls.some((call) => call.method === 'files.searchPaths')).toBe(false)
  })
})

function statusResponse(capable: boolean): RuntimeRpcResponse<unknown> {
  return success({
    runtimeId: 'runtime-1',
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
    capabilities: capable ? [WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY] : [],
    pathSearchCapabilities: capable
      ? {
          [WORKSPACE_PATH_SEARCH_CAPABILITY_DOCUMENT_KEY]:
            RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR
        }
      : {}
  })
}

function success(result: unknown): RuntimeRpcResponse<unknown> {
  return {
    id: 'test-call',
    ok: true,
    result,
    _meta: { runtimeId: 'runtime-1' }
  }
}
