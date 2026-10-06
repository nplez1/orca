import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handlers, resetFilesystemIpcMocks, store } from '../filesystem-test-harness'
import type * as FilesystemAuth from '../filesystem-auth'
import type * as WorkspacePathIndexRuntime from '../../workspace-path-index/workspace-path-index-runtime'
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
  return {
    ensure,
    cancelLocalConsumer,
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
  createLocalWorkspacePathIndexService: () => pathIndexMock.service
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
})
