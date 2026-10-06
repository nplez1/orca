import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handlers, resetFilesystemIpcMocks, store } from '../filesystem-test-harness'
import type * as FilesystemAuth from '../filesystem-auth'
import type * as WorkspacePathIndexRuntime from '../../workspace-path-index/workspace-path-index-runtime'
import { createCompleteWorkspacePathSearchResponse } from '../../../shared/workspace-path-search-response'
import type { WorkspacePathIndexEnsureArgs } from '../../workspace-path-index/workspace-path-index-ensure'
import { WorkspacePathIndexService } from '../../workspace-path-index/workspace-path-index-service'
import { createSenderScopedRequestCancellations } from '../sender-scoped-request-cancellation'
import { WORKSPACE_PATH_INDEX_DISABLE_ENV } from '../../workspace-path-index/workspace-path-index-feature-switch'
import { createFilesystemHandlerContext } from './filesystem-handler-context'
import { registerFilesystemSearchHandlers } from './filesystem-search-handlers'

const listFilesMock = vi.hoisted(() => ({ listQuickOpenFiles: vi.fn(async () => ['src/app.ts']) }))
const pathSearchMock = vi.hoisted(() => ({
  searchQuickOpenFilePaths: vi.fn(async () => ({
    paths: ['fallback.ts'],
    totalCount: 1,
    truncated: false
  }))
}))
const authMock = vi.hoisted(() => ({
  resolveAuthorizedPath: vi.fn(async (rootPath: string) => `/canonical${rootPath}`)
}))
const pathIndexMock = vi.hoisted(() => {
  const ensure = vi.fn(async () => ({ ready: false, key: null, reason: 'building' }))
  const cancelLocalConsumer = vi.fn()
  /** Holds the real service for a test that needs the real query scheduler. */
  const state: { override: unknown } = { override: null }
  return {
    ensure,
    cancelLocalConsumer,
    state,
    service: {
      ensure,
      cancelLocalConsumer,
      acquireLease: vi.fn(async () => null),
      releaseLease: vi.fn(),
      search: vi.fn(),
      recordDegradation: vi.fn()
    }
  }
})

vi.mock('electron', async () => (await import('../filesystem-test-harness')).electronMock)
vi.mock('../filesystem-list-files', () => listFilesMock)
vi.mock('../filesystem-search-file-paths', () => pathSearchMock)
vi.mock('../filesystem-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof FilesystemAuth>()),
  resolveAuthorizedPath: authMock.resolveAuthorizedPath
}))
vi.mock('../../workspace-path-index/workspace-path-index-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspacePathIndexRuntime>()),
  createLocalWorkspacePathIndexService: () => pathIndexMock.state.override ?? pathIndexMock.service
}))

function senderEvent(): { sender: EventEmitter & { id: number } } {
  return { sender: Object.assign(new EventEmitter(), { id: 7 }) }
}

async function invoke(channel: string, event: unknown, args: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return await handler(event, args)
}

function registerSearchHandlers(): void {
  registerFilesystemSearchHandlers(
    createFilesystemHandlerContext(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all store access is mocked for these handlers.
      store as never,
      undefined,
      createSenderScopedRequestCancellations(),
      createSenderScopedRequestCancellations()
    )
  )
}

/** Warms the worker-owned catalog through the real service, so a query is served from a warm index. */
async function registerHandlersWithWarmPathIndex(
  service: WorkspacePathIndexService
): Promise<void> {
  const runServiceEnsure = service.ensure.bind(service)
  let resolvePrewarmArgs: (args: WorkspacePathIndexEnsureArgs) => void = () => {}
  const prewarmArgs = new Promise<WorkspacePathIndexEnsureArgs>((resolve) => {
    resolvePrewarmArgs = resolve
  })
  vi.spyOn(service, 'ensure').mockImplementation(async (args) => {
    resolvePrewarmArgs(args)
    return await runServiceEnsure(args)
  })
  registerSearchHandlers()

  await invoke('fs:listFiles', senderEvent(), { rootPath: '/repo', requestToken: 'warm-token' })
  await vi.waitFor(() => expect(service.ensure).toHaveBeenCalled())
  const warmedArgs = await prewarmArgs
  await vi.waitFor(async () => {
    await expect(runServiceEnsure(warmedArgs)).resolves.toMatchObject({ ready: true })
  })
}

describe('filesystem quick-open path-index wiring', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    listFilesMock.listQuickOpenFiles.mockClear()
    authMock.resolveAuthorizedPath.mockReset()
    authMock.resolveAuthorizedPath.mockImplementation(
      async (rootPath: string) => `/canonical${rootPath}`
    )
    pathIndexMock.ensure.mockClear()
    pathIndexMock.cancelLocalConsumer.mockClear()
    pathIndexMock.state.override = null
    pathSearchMock.searchQuickOpenFilePaths.mockClear()
    delete process.env[WORKSPACE_PATH_INDEX_DISABLE_ENV]
  })

  it('prewarms the worker-owned catalog while the explorer lists', async () => {
    registerSearchHandlers()

    const listing = await invoke('fs:listFiles', senderEvent(), {
      rootPath: '/repo',
      requestToken: 'list-token'
    })

    expect(listing).toEqual(['src/app.ts'])
    await vi.waitFor(() => expect(pathIndexMock.ensure).toHaveBeenCalledTimes(1))
    expect(pathIndexMock.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: {
          executionHost: { provider: 'local', incarnationId: String(process.pid) },
          authorizedCanonicalRoot: '/canonical/repo'
        },
        firstScope: 'included',
        activeWorkspace: true,
        correlationId: 'list-7'
      })
    )
  })

  it('still lists when the root cannot be authorized for the index', async () => {
    authMock.resolveAuthorizedPath.mockRejectedValueOnce(new Error('outside allowed directories'))
    registerSearchHandlers()

    await expect(
      invoke('fs:listFiles', senderEvent(), { rootPath: '/repo', requestToken: 'list-token' })
    ).resolves.toEqual(['src/app.ts'])
    expect(pathIndexMock.ensure).not.toHaveBeenCalled()
  })

  it('cancels no index consumer for a token that owns no worker query', async () => {
    registerSearchHandlers()

    // A listing submits no worker query — its prewarm only builds one — so its token owns no
    // consumer, and a late cancel of it must not reach another consumer's query.
    await invoke('fs:cancelListFiles', senderEvent(), { requestToken: 'list-token' })

    expect(pathIndexMock.cancelLocalConsumer).not.toHaveBeenCalled()
  })

  it('leaves the index alone when the feature switch disables it', async () => {
    process.env[WORKSPACE_PATH_INDEX_DISABLE_ENV] = '1'
    registerSearchHandlers()

    await invoke('fs:listFiles', senderEvent(), { rootPath: '/repo', requestToken: 'list-token' })
    await invoke('fs:cancelListFiles', senderEvent(), { requestToken: 'list-token' })

    expect(pathIndexMock.ensure).not.toHaveBeenCalled()
    expect(pathIndexMock.cancelLocalConsumer).not.toHaveBeenCalled()
  })

  it('stops the worker query of a renderer-named consumer through its request token', async () => {
    const consumerId = '3f0d1c9a-1b5e-4f2a-8c3d-5e6f7a8b9c0d'
    const cancelledWorkerConsumers: string[] = []
    let releaseWorkerQuery = (): void => {}
    let queryStarts = 0
    const workerQueryReleased = new Promise<void>((resolve) => {
      releaseWorkerQuery = resolve
    })
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build: async (request) => ({ generationId: request.generationId, retainedBytes: 64 }),
      cancelQuery: (consumerKey) => {
        cancelledWorkerConsumers.push(consumerKey)
        releaseWorkerQuery()
      },
      query: async (request) => {
        queryStarts += 1
        await workerQueryReleased
        return createCompleteWorkspacePathSearchResponse({
          requestIdentity: request.identity,
          paths: [],
          totalCount: 0,
          generationId: request.identity.generationId ?? 'test-generation'
        })
      }
    })
    pathIndexMock.state.override = service
    // The listing prewarms the worker-owned catalog, so the filter queries a warm one.
    await registerHandlersWithWarmPathIndex(service)

    const searchPromise = invoke('fs:searchFilePaths', senderEvent(), {
      rootPath: '/repo',
      requestToken: 'filter-token',
      query: 'app',
      mode: 'name-filter',
      consumerId,
      consumerSequence: 1
    })
    await vi.waitFor(() => expect(queryStarts).toBe(1))

    await invoke('fs:cancelListFiles', senderEvent(), { requestToken: 'filter-token' })

    // Cancels the query that was submitted, and only that one: not the sender-id fallback.
    expect(cancelledWorkerConsumers).toEqual([`local:${process.pid}:${consumerId}`])
    // The scheduler's own verdict: the submit it was holding resolves as cancelled.
    await expect(searchPromise).resolves.toMatchObject({
      files: [],
      truncated: true,
      workspacePathSearch: { degradationReason: 'cancelled' }
    })
    service.dispose()
  })

  it('does not submit a worker query when the request is cancelled while it is still authorizing', async () => {
    const consumerId = '8b2d3c4e-5f60-4a71-8b92-0c1d2e3f4a5b'
    let queryStarts = 0
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build: async (request) => ({ generationId: request.generationId, retainedBytes: 64 }),
      cancelQuery: () => {},
      query: async (request) => {
        queryStarts += 1
        return createCompleteWorkspacePathSearchResponse({
          requestIdentity: request.identity,
          paths: [],
          totalCount: 0,
          generationId: request.identity.generationId ?? 'test-generation'
        })
      }
    })
    pathIndexMock.state.override = service
    await registerHandlersWithWarmPathIndex(service)

    let releaseAuthorization = (): void => {}
    let authorizationEntered = false
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve
    })
    authMock.resolveAuthorizedPath.mockImplementationOnce(async (rootPath: string) => {
      authorizationEntered = true
      await authorizationGate
      return `/canonical${rootPath}`
    })

    const searchPromise = invoke('fs:searchFilePaths', senderEvent(), {
      rootPath: '/repo',
      requestToken: 'authorizing-token',
      query: 'app',
      mode: 'name-filter',
      consumerId,
      consumerSequence: 1
    })
    await vi.waitFor(() => expect(authorizationEntered).toBe(true))

    await invoke('fs:cancelListFiles', senderEvent(), { requestToken: 'authorizing-token' })
    releaseAuthorization()

    // Pre-fix failure: the cancel was recorded before the await but the submission never checked it,
    // so the query started (queryStarts === 1) and answered complete instead of cancelled.
    await expect(searchPromise).resolves.toMatchObject({
      files: [],
      truncated: true,
      workspacePathSearch: { degradationReason: 'cancelled' }
    })
    expect(queryStarts).toBe(0)
    service.dispose()
  })

  it('does not cancel an unrelated in-flight query when a settled token is cancelled late', async () => {
    const consumerId = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f'
    const cancelledWorkerConsumers: string[] = []
    let holdQueries = false
    let releaseHeldQuery = (): void => {}
    const heldQueryGate = new Promise<void>((resolve) => {
      releaseHeldQuery = resolve
    })
    let queryStarts = 0
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build: async (request) => ({ generationId: request.generationId, retainedBytes: 64 }),
      cancelQuery: (consumerKey) => cancelledWorkerConsumers.push(consumerKey),
      query: async (request) => {
        queryStarts += 1
        if (holdQueries) {
          await heldQueryGate
        }
        return createCompleteWorkspacePathSearchResponse({
          requestIdentity: request.identity,
          paths: holdQueries ? ['unrelated.ts'] : [],
          totalCount: holdQueries ? 1 : 0,
          generationId: request.identity.generationId ?? 'test-generation'
        })
      }
    })
    pathIndexMock.state.override = service
    await registerHandlersWithWarmPathIndex(service)

    const settled = invoke('fs:searchFilePaths', senderEvent(), {
      rootPath: '/repo',
      requestToken: 'settled-token',
      query: 'app',
      mode: 'name-filter',
      consumerId,
      consumerSequence: 1
    })
    await expect(settled).resolves.toMatchObject({ truncated: false })

    holdQueries = true
    const unrelated = invoke('fs:searchFilePaths', senderEvent(), {
      rootPath: '/repo',
      requestToken: 'unnamed-token',
      query: 'app',
      mode: 'name-filter'
    })
    await vi.waitFor(() => expect(queryStarts).toBe(2))

    // The renderer's next cancel names the token that already settled, which owns no consumer.
    await invoke('fs:cancelListFiles', senderEvent(), { requestToken: 'settled-token' })

    // Pre-fix failure: the settled token fell back to `local:<pid>:7` and killed the live query,
    // so this was [`local:<pid>:7`] and the unrelated request resolved cancelled.
    expect(cancelledWorkerConsumers).toEqual([])

    releaseHeldQuery()
    // The worker's own result reaches the renderer, so the unrelated query ran to completion.
    await expect(unrelated).resolves.toMatchObject({
      files: ['unrelated.ts'],
      totalCount: 1,
      truncated: false
    })
    service.dispose()
  })

  it('still cancels the sender-keyed consumer of an unnamed request that is in flight', async () => {
    let releaseHeldQuery = (): void => {}
    const heldQueryGate = new Promise<void>((resolve) => {
      releaseHeldQuery = resolve
    })
    const cancelledWorkerConsumers: string[] = []
    let queryStarts = 0
    const service = new WorkspacePathIndexService({
      authorize: async (owner) => owner.authorizedCanonicalRoot,
      build: async (request) => ({ generationId: request.generationId, retainedBytes: 64 }),
      cancelQuery: (consumerKey) => cancelledWorkerConsumers.push(consumerKey),
      query: async (request) => {
        queryStarts += 1
        await heldQueryGate
        return createCompleteWorkspacePathSearchResponse({
          requestIdentity: request.identity,
          paths: [],
          totalCount: 0,
          generationId: request.identity.generationId ?? 'test-generation'
        })
      }
    })
    pathIndexMock.state.override = service
    await registerHandlersWithWarmPathIndex(service)

    const unnamed = invoke('fs:searchFilePaths', senderEvent(), {
      rootPath: '/repo',
      requestToken: 'unnamed-token',
      query: 'app',
      mode: 'name-filter'
    })
    await vi.waitFor(() => expect(queryStarts).toBe(1))

    await invoke('fs:cancelListFiles', senderEvent(), { requestToken: 'unnamed-token' })
    expect(cancelledWorkerConsumers).toEqual([`local:${process.pid}:7`])

    releaseHeldQuery()
    await expect(unnamed).resolves.toMatchObject({
      files: [],
      truncated: true,
      workspacePathSearch: { degradationReason: 'cancelled' }
    })
    service.dispose()
  })
})
