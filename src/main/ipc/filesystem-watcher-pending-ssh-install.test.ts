import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, getSshFilesystemProviderMock, providerRegistrationListeners } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    getSshFilesystemProviderMock: vi.fn(),
    providerRegistrationListeners: new Set<(connectionId: string) => void>()
  })
)

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('fs/promises', () => ({
  stat: vi.fn()
}))

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn()
}))

vi.mock('./filesystem-watcher-wsl', () => ({
  createWslWatcher: vi.fn()
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock,
  onSshFilesystemProviderRegistered: (listener: (connectionId: string) => void) => {
    providerRegistrationListeners.add(listener)
    return () => providerRegistrationListeners.delete(listener)
  }
}))

import { closeAllWatchers, registerFilesystemWatcherHandlers } from './filesystem-watcher'
import { stat } from 'node:fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'
import { createWslWatcher } from './filesystem-watcher-wsl'
import { resetWatcherChildRegistryForTest } from './parcel-watcher-child-registry'
import { WATCH_BATCH_TRAILING_MS } from '../../shared/filesystem-watch-batch-window'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

/** Remote fs:changed rides the shared debounce window, so drain it before asserting sends. */
const emitRemote = async (onEvents: (e: unknown[]) => void, events: unknown[]) => {
  onEvents(events)
  await (vi.isFakeTimers()
    ? vi.advanceTimersByTimeAsync(WATCH_BATCH_TRAILING_MS)
    : new Promise((resolve) => setTimeout(resolve, WATCH_BATCH_TRAILING_MS + 25)))
}

describe('registerFilesystemWatcherHandlers pending SSH install lifecycle', () => {
  const handlers: HandlerMap = {}
  const originalPlatform = process.platform

  beforeEach(async () => {
    vi.useRealTimers()
    handleMock.mockReset()
    getSshFilesystemProviderMock.mockReset()
    vi.mocked(stat).mockReset()
    vi.mocked(subscribeParcelWatcher).mockReset()
    vi.mocked(createWslWatcher).mockReset()
    resetWatcherChildRegistryForTest()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  it('unsubscribes if the sender is destroyed while an SSH watcher is opening', async () => {
    const destroyedCallbacks: (() => void)[] = []
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'destroyed') {
          destroyedCallbacks.push(callback)
        }
      }),
      id: 1
    }
    const unwatchMock = vi.fn()
    let resolveWatch: (unwatch: () => void) => void = () => {}
    const watchPromise = new Promise<() => void>((resolve) => {
      resolveWatch = resolve
    })
    const watchMock = vi.fn().mockReturnValue(watchPromise)
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    const watch = handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    ) as Promise<unknown>

    await Promise.resolve()
    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(destroyedCallbacks).toHaveLength(1)

    destroyedCallbacks[0]()
    resolveWatch(unwatchMock)
    await watch

    expect(unwatchMock).toHaveBeenCalledTimes(1)
    const onEvents = watchMock.mock.calls[0][1]
    await emitRemote(onEvents, [{ path: '/home/me/repo/file.txt', type: 'update' }])
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('revives a pending SSH watcher install when a new sender joins after cancellation', async () => {
    const args = { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    const senderOne = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const senderTwo = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }
    const unwatchMock = vi.fn()
    let resolveWatch!: (unwatch: () => void) => void
    const watchMock = vi.fn().mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveWatch = resolve
      })
    )
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    const firstWatch = handlers['fs:watchWorktree']({ sender: senderOne }, args) as Promise<unknown>

    await Promise.resolve()
    handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, args)
    const secondWatch = handlers['fs:watchWorktree'](
      { sender: senderTwo },
      args
    ) as Promise<unknown>

    expect(watchMock).toHaveBeenCalledTimes(1)
    resolveWatch(unwatchMock)
    await Promise.all([firstWatch, secondWatch])

    const onEvents = watchMock.mock.calls[0][1]
    await emitRemote(onEvents, [{ path: '/home/me/repo/file.txt', type: 'update' }])
    expect(senderOne.send).not.toHaveBeenCalled()
    expect(senderTwo.send).toHaveBeenCalledTimes(1)

    handlers['fs:unwatchWorktree']({ sender: { id: 2 } }, args)
    expect(unwatchMock).toHaveBeenCalledTimes(1)
  })

  it('registers one destroyed listener for many SSH worktree watches', async () => {
    const destroyedCallbacks: (() => void)[] = []
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'destroyed') {
          destroyedCallbacks.push(callback)
        }
      }),
      id: 99
    }
    const unwatchMock = vi.fn()
    const watchMock = vi.fn().mockResolvedValue(unwatchMock)
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    for (let i = 0; i < 12; i += 1) {
      await handlers['fs:watchWorktree'](
        { sender },
        { worktreePath: `/home/me/repo-${i}`, connectionId: 'conn-1' }
      )
    }

    // Why: WebContents warns after 10 listeners. The cleanup work still covers
    // every remote watch by scanning the shared remote watcher registry.
    expect(sender.once).toHaveBeenCalledTimes(1)
    expect(destroyedCallbacks).toHaveLength(1)

    destroyedCallbacks[0]()

    expect(unwatchMock).toHaveBeenCalledTimes(12)
  })
})
