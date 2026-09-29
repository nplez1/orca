import { createWatcherSender } from './filesystem-watcher-test-sender'
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
import { createDebouncedBatch } from './filesystem-watcher-batch-control'
import {
  subscribeLocalPathIndexWatcher,
  unsubscribeLocalPathIndexWatcher
} from './filesystem-watcher-local-subscription'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  MAX_PHYSICAL_WATCHER_CHILDREN,
  reserveWatcherChild,
  resetWatcherChildRegistryForTest,
  WatcherChildCapacityError
} from './parcel-watcher-child-registry'
import { acquireWatcherRemovalGate } from './watcher-removal-gate'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('registerFilesystemWatcherHandlers', () => {
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

  it('reuses the registry watcher for the index without a renderer listener', async () => {
    const rootPath = '/workspace/index-only'
    watcherLifecycleState.localWatchersClosed = false
    const { key } = getLocalWatcherRoot(rootPath)
    watcherLifecycleState.watchedRoots.set(key, {
      subscription: { unsubscribe: vi.fn(async () => undefined) },
      listeners: new Map(),
      indexConsumers: new Set(),
      batch: createDebouncedBatch(),
      eventSequence: 0,
      indexReconciliationPromise: Promise.resolve(),
      indexReconciliationController: new AbortController(),
      indexCoverageTimer: null,
      rootPath
    })

    await expect(subscribeLocalPathIndexWatcher(rootPath)).resolves.toBe(true)

    expect(watcherLifecycleState.watchedRoots.get(key)?.listeners.size).toBe(0)
    expect(watcherLifecycleState.watchedRoots.get(key)?.indexConsumers).toContain(
      'workspace-path-index'
    )
    unsubscribeLocalPathIndexWatcher(rootPath)
    await closeAllWatchers()
  })

  it('pins Parcel to the Windows backend for local Windows watches', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: vi.fn() } as never)

    await handlers['fs:watchWorktree'](
      { sender: createWatcherSender(1) },
      { worktreePath: 'C:\\repo' }
    )

    expect(subscribeParcelWatcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ backend: 'windows' })
    )

    await closeAllWatchers()
  })

  it('automatically retries a WSL watcher when child capacity becomes available', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const heldReservations = Array.from({ length: MAX_PHYSICAL_WATCHER_CHILDREN }, () =>
      reserveWatcherChild()
    )
    vi.mocked(createWslWatcher).mockImplementation(async (_rootKey, worktreePath) => {
      const release = reserveWatcherChild()
      if (!release) {
        throw new WatcherChildCapacityError()
      }
      return {
        subscription: { unsubscribe: vi.fn(async () => release()) },
        listeners: new Map(),
        indexConsumers: new Set(),
        batch: createDebouncedBatch(),
        eventSequence: 0,
        indexReconciliationPromise: Promise.resolve(),
        indexReconciliationController: new AbortController(),
        indexCoverageTimer: null,
        rootPath: worktreePath
      }
    })
    const sender = createWatcherSender(1)
    const args = { worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo' }

    await expect(handlers['fs:watchWorktree']({ sender }, args)).resolves.toBeUndefined()
    expect(createWslWatcher).toHaveBeenCalledOnce()

    heldReservations.pop()?.()
    await vi.waitFor(() => expect(createWslWatcher).toHaveBeenCalledTimes(2))
    await closeAllWatchers()
    heldReservations.forEach((release) => release?.())
  })

  it('cancels a pending WSL capacity retry when the renderer unwatches', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const heldReservations = Array.from({ length: MAX_PHYSICAL_WATCHER_CHILDREN }, () =>
      reserveWatcherChild()
    )
    vi.mocked(createWslWatcher).mockRejectedValue(new WatcherChildCapacityError())
    const sender = createWatcherSender(1)
    const args = { worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo' }

    await handlers['fs:watchWorktree']({ sender }, args)
    handlers['fs:unwatchWorktree']({ sender: { id: sender.id } }, args)
    heldReservations.pop()?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(createWslWatcher).toHaveBeenCalledOnce()
    heldReservations.forEach((release) => release?.())
  })

  it('rejects installs during destructive removal and allows a retry afterward', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: vi.fn() } as never)
    const sender = createWatcherSender(1)
    const removal = acquireWatcherRemovalGate('/repo')
    await removal.ready

    await expect(
      handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo' })
    ).rejects.toMatchObject({ code: 'watcher_removal_in_progress' })
    expect(subscribeParcelWatcher).not.toHaveBeenCalled()

    removal.release()
    await expect(
      handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo' })
    ).resolves.toBeUndefined()
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(1)
  })
})
