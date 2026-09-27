import type { WebContents } from 'electron'
import { beginWatcherInstall } from './watcher-removal-gate'
import type { LocalWatcherInstallToken } from './filesystem-watcher-lifecycle-state'
import {
  WATCHER_TEARDOWN_GRACE_MS,
  watcherLifecycleState
} from './filesystem-watcher-lifecycle-state'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import type { WatchedRoot } from './filesystem-watcher-wsl'
import {
  addInFlightLocalInstallListener,
  addLocalWatchListener,
  clearLocalCapacityRetry,
  rememberUnwatchableRoot,
  registerWatcherSenderCleanup,
  takeLocalCapacityRetryListeners,
  trackDetachedLocalUnsubscribe
} from './filesystem-watcher-listener-lifecycle'
import { cancelLocalBatchFlush } from './filesystem-watcher-batch-control'
import { scheduleLocalCapacityRetry } from './filesystem-watcher-local-capacity'
import { installLocalWatcher } from './filesystem-watcher-local-install'
import { isCurrentWatcherSender } from './filesystem-watcher-sender-lifetime'
import { evictQuickOpenPathInventory } from './quick-open-path-inventory'
import { scheduleLocalWorkspacePathIndexCoverage } from './filesystem-watcher-path-index-coverage'

// ── Subscribe / Unsubscribe ──────────────────────────────────────────

const LOCAL_PATH_INDEX_CONSUMER_ID = 'workspace-path-index'

export async function subscribeLocalWatcher(
  worktreePath: string,
  sender: WebContents,
  generation = watcherLifecycleState.localWatcherLifecycleGeneration,
  senderSignal = registerWatcherSenderCleanup(sender)
): Promise<void> {
  if (
    !isCurrentWatcherSender(sender, senderSignal) ||
    watcherLifecycleState.localWatchersClosed ||
    generation !== watcherLifecycleState.localWatcherLifecycleGeneration
  ) {
    return
  }
  const finishInstall = beginWatcherInstall(worktreePath)
  try {
    await subscribeWhileRemovalAllowed(worktreePath, sender, generation, senderSignal)
  } finally {
    finishInstall()
  }
}

export async function subscribeLocalPathIndexWatcher(worktreePath: string): Promise<boolean> {
  if (watcherLifecycleState.localWatchersClosed) {
    return false
  }
  const generation = watcherLifecycleState.localWatcherLifecycleGeneration
  const finishInstall = beginWatcherInstall(worktreePath)
  try {
    await subscribeWhileRemovalAllowed(
      worktreePath,
      undefined,
      generation,
      undefined,
      LOCAL_PATH_INDEX_CONSUMER_ID
    )
  } finally {
    finishInstall()
  }
  const { key } = getLocalWatcherRoot(worktreePath)
  return (
    watcherLifecycleState.watchedRoots.get(key)?.indexConsumers.has(LOCAL_PATH_INDEX_CONSUMER_ID) ??
    false
  )
}

export function unsubscribeLocalPathIndexWatcher(worktreePath: string): void {
  const { key: rootKey } = getLocalWatcherRoot(worktreePath)
  const inFlight = watcherLifecycleState.inFlightLocalInstalls.get(rootKey)
  if (inFlight) {
    inFlight.indexConsumers.delete(LOCAL_PATH_INDEX_CONSUMER_ID)
    inFlight.cancelled = inFlight.listeners.size === 0 && inFlight.indexConsumers.size === 0
    if (inFlight.cancelled) {
      inFlight.abortController.abort()
    }
  }
  const root = watcherLifecycleState.watchedRoots.get(rootKey)
  if (!root) {
    return
  }
  root.indexConsumers.delete(LOCAL_PATH_INDEX_CONSUMER_ID)
  scheduleLocalWorkspacePathIndexCoverage(root)
  if (root.listeners.size === 0 && root.indexConsumers.size === 0) {
    scheduleLocalWatcherTeardown(rootKey, root)
  }
}

async function subscribeWhileRemovalAllowed(
  worktreePath: string,
  sender: WebContents | undefined,
  generation: number,
  senderSignal: AbortSignal | undefined,
  indexConsumerId?: string
): Promise<void> {
  if (
    (sender !== undefined &&
      (senderSignal === undefined || !isCurrentWatcherSender(sender, senderSignal))) ||
    watcherLifecycleState.localWatchersClosed ||
    generation !== watcherLifecycleState.localWatcherLifecycleGeneration
  ) {
    return
  }
  const { key: rootKey, path: rootPath } = getLocalWatcherRoot(worktreePath)
  if (sender?.isDestroyed()) {
    return
  }

  // Don't retry roots that already failed — avoids repeated error spam.
  if (watcherLifecycleState.unwatchableRoots.has(rootKey)) {
    rememberUnwatchableRoot(rootKey)
    return
  }

  const root = watcherLifecycleState.watchedRoots.get(rootKey)

  // Cancel any pending grace-period teardown — a new listener arrived.
  const pendingTeardown = watcherLifecycleState.pendingTeardowns.get(rootKey)
  if (pendingTeardown) {
    clearTimeout(pendingTeardown)
    watcherLifecycleState.pendingTeardowns.delete(rootKey)
  }
  const capacityRetryListeners = takeLocalCapacityRetryListeners(rootKey)
  const retrySignals = new Map(
    capacityRetryListeners.map((listener) => [listener.id, registerWatcherSenderCleanup(listener)])
  )

  if (root) {
    for (const listener of capacityRetryListeners) {
      addLocalWatchListener(rootKey, listener)
    }
    if (sender) {
      addLocalWatchListener(rootKey, sender)
    }
    if (indexConsumerId) {
      root.indexConsumers.add(indexConsumerId)
      scheduleLocalWorkspacePathIndexCoverage(root)
    }
    return
  }

  const pendingInstall = watcherLifecycleState.pendingLocalInstallPromises.get(rootKey)
  if (pendingInstall) {
    const inFlight = watcherLifecycleState.inFlightLocalInstalls.get(rootKey)
    const canJoinInstall = inFlight && !inFlight.abortController.signal.aborted
    if (canJoinInstall) {
      // Why: an unwatch may cancel an install while another consumer awaits the same root; a new consumer keeps it alive.
      if (sender) {
        addInFlightLocalInstallListener(inFlight, sender)
      }
      if (indexConsumerId) {
        inFlight.indexConsumers.add(indexConsumerId)
        inFlight.cancelled = false
      }
      for (const listener of capacityRetryListeners) {
        addInFlightLocalInstallListener(inFlight, listener)
      }
    }
    const result = await pendingInstall
    const liveCapacityListeners = capacityRetryListeners.filter((listener) =>
      isCurrentWatcherSender(listener, retrySignals.get(listener.id)!)
    )
    const senderIsCurrent =
      sender !== undefined &&
      senderSignal !== undefined &&
      isCurrentWatcherSender(sender, senderSignal)
    if (
      result === 'cancelled' &&
      !canJoinInstall &&
      !watcherLifecycleState.localWatchersClosed &&
      generation === watcherLifecycleState.localWatcherLifecycleGeneration
    ) {
      // Why: AbortSignal can't be revived; listeners arriving after cancellation wait out that generation, then own a fresh install.
      if (watcherLifecycleState.pendingLocalInstallPromises.get(rootKey) === pendingInstall) {
        watcherLifecycleState.pendingLocalInstallPromises.delete(rootKey)
      }
      const retryListeners = new Map(
        liveCapacityListeners.map((listener) => [listener.id, listener])
      )
      if (sender && senderIsCurrent) {
        retryListeners.set(sender.id, sender)
      }
      if (indexConsumerId) {
        await subscribeWhileRemovalAllowed(
          worktreePath,
          sender,
          generation,
          senderSignal,
          indexConsumerId
        )
      }
      for (const listener of retryListeners.values()) {
        if (!listener.isDestroyed()) {
          await subscribeWhileRemovalAllowed(
            worktreePath,
            listener,
            generation,
            listener === sender ? senderSignal : retrySignals.get(listener.id)!
          )
        }
      }
      return
    }
    if (!inFlight) {
      if (result === 'installed') {
        for (const listener of liveCapacityListeners) {
          addLocalWatchListener(rootKey, listener)
        }
      } else if (result === 'capacity') {
        const retryListeners = new Map(
          liveCapacityListeners.map((listener) => [listener.id, listener])
        )
        if (sender && senderIsCurrent) {
          retryListeners.set(sender.id, sender)
        }
        scheduleLocalCapacityRetry(rootKey, worktreePath, retryListeners, subscribeLocalWatcher)
      }
    }
    if (result === 'installed' && watcherLifecycleState.watchedRoots.has(rootKey)) {
      const installedRoot = watcherLifecycleState.watchedRoots.get(rootKey)
      if (sender && senderIsCurrent && (!inFlight || inFlight.listeners.has(sender.id))) {
        addLocalWatchListener(rootKey, sender)
      }
      if (indexConsumerId && installedRoot) {
        installedRoot.indexConsumers.add(indexConsumerId)
        scheduleLocalWorkspacePathIndexCoverage(installedRoot)
      }
    }
    return
  }

  const cancelToken: LocalWatcherInstallToken = {
    cancelled: false,
    listeners: new Map(),
    indexConsumers: new Set(indexConsumerId ? [indexConsumerId] : []),
    abortController: new AbortController()
  }
  watcherLifecycleState.inFlightLocalInstalls.set(rootKey, cancelToken)
  for (const listener of capacityRetryListeners) {
    addInFlightLocalInstallListener(cancelToken, listener)
  }
  if (sender) {
    addInFlightLocalInstallListener(cancelToken, sender)
  }
  const installPromise = installLocalWatcher(
    rootKey,
    rootPath,
    worktreePath,
    cancelToken,
    (listeners) =>
      scheduleLocalCapacityRetry(rootKey, worktreePath, listeners, subscribeLocalWatcher)
  )
  watcherLifecycleState.pendingLocalInstallPromises.set(rootKey, installPromise)
  try {
    await installPromise
  } finally {
    if (watcherLifecycleState.pendingLocalInstallPromises.get(rootKey) === installPromise) {
      watcherLifecycleState.pendingLocalInstallPromises.delete(rootKey)
    }
  }
}

export function unsubscribeLocalWatcher(worktreePath: string, senderId: number): void {
  const { key: rootKey } = getLocalWatcherRoot(worktreePath)
  const suspended = watcherLifecycleState.suspendedLocalWatcherListeners.get(rootKey)
  suspended?.listeners.delete(senderId)
  if (suspended?.listeners.size === 0) {
    watcherLifecycleState.suspendedLocalWatcherListeners.delete(rootKey)
  }
  const capacityRetry = watcherLifecycleState.pendingLocalCapacityRetries.get(rootKey)
  if (capacityRetry) {
    capacityRetry.listeners.delete(senderId)
    if (capacityRetry.listeners.size === 0) {
      clearLocalCapacityRetry(rootKey)
    }
  }
  const inFlight = watcherLifecycleState.inFlightLocalInstalls.get(rootKey)
  if (inFlight) {
    inFlight.listeners.delete(senderId)
    inFlight.cancelled = inFlight.listeners.size === 0 && inFlight.indexConsumers.size === 0
    // Why: last normal disconnect must abort the pending native/forked install (same early-cancel as closeLocalWatcherForWorktreePath).
    if (inFlight.cancelled) {
      inFlight.abortController.abort()
    }
  }

  const root = watcherLifecycleState.watchedRoots.get(rootKey)
  if (!root) {
    return
  }

  root.listeners.delete(senderId)

  // Defer teardown when the last subscriber leaves so rapid worktree switches reuse the native watcher.
  if (root.listeners.size === 0 && root.indexConsumers.size === 0) {
    scheduleLocalWatcherTeardown(rootKey, root)
  }
}

function scheduleLocalWatcherTeardown(rootKey: string, root: WatchedRoot): void {
  if (root.batch.timer) {
    clearTimeout(root.batch.timer)
    // Why: a cleared handle can't be refresh()ed; null it so a grace-window re-subscribe arms a fresh window.
    root.batch.timer = null
  }
  // Why: duplicate unwatch calls for a root would leak overwritten grace timers; keep just one.
  if (watcherLifecycleState.pendingTeardowns.has(rootKey)) {
    return
  }

  const teardownTimer = setTimeout(() => {
    watcherLifecycleState.pendingTeardowns.delete(rootKey)
    // Re-check: a new listener may have arrived during the grace period.
    const currentRoot = watcherLifecycleState.watchedRoots.get(rootKey)
    if (!currentRoot || currentRoot.listeners.size > 0 || currentRoot.indexConsumers.size > 0) {
      return
    }
    void trackDetachedLocalUnsubscribe(rootKey, currentRoot)
    cancelLocalBatchFlush(currentRoot)
    // Why: a workspace nobody is watching does not need a warm path index either.
    evictQuickOpenPathInventory(currentRoot.rootPath)
    watcherLifecycleState.watchedRoots.delete(rootKey)
  }, WATCHER_TEARDOWN_GRACE_MS)

  watcherLifecycleState.pendingTeardowns.set(rootKey, teardownTimer)
}
