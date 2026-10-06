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
      store as never,
      undefined,
      createSenderScopedRequestCancellations(),
      createSenderScopedRequestCancellations()
    )
  )
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

  it('stops the sender-scoped index query when the listing is cancelled', async () => {
    registerSearchHandlers()

    await invoke('fs:cancelListFiles', senderEvent(), { requestToken: 'list-token' })

    expect(pathIndexMock.cancelLocalConsumer).toHaveBeenCalledWith('7')
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
})
