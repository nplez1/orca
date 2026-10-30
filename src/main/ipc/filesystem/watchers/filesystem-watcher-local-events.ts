import { stat } from 'node:fs/promises'
import type { FsChangeEvent, FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import { watchBatchFlushDelayMs } from '../../../../shared/filesystem-watch-batch-window'
import { MAX_BATCHED_WATCHER_EVENTS, queueWatcherEvents } from './filesystem-watcher-event-batch'
// Filter high-churn events at source; Explorer display filters only hide rows.
import { WATCHER_IGNORE_DIRS, buildParcelWatcherIgnoreOptions } from './filesystem-watcher-ignore'
import type { WatchedRoot } from './filesystem-watcher-wsl'
import { subscribeViaWatcherProcess } from '../watcher-process/parcel-watcher-process'
import { coalesceEvents } from './filesystem-watcher-event-coalescing'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  retainLocalWatcherPhysicalFailure,
  trackDetachedLocalUnsubscribe
} from './filesystem-watcher-listener-lifecycle'
import { cancelLocalBatchFlush, createDebouncedBatch } from './filesystem-watcher-batch-control'
import { invalidateQuickOpenPathInventory } from '../../quick-open-path-inventory'
import {
  beginLocalWorkspacePathIndexReconciliation,
  completeLocalWorkspacePathIndexReconciliation
} from '../../../workspace-path-index/workspace-path-index-runtime'
import {
  isWorkspacePathIndexPolicyEvent,
  isWorkspacePathIndexPolicyPath,
  needsWorkspacePathIndexReconciliation,
  reconcileLocalWorkspacePathIndexEvents
} from './filesystem-watcher-path-index-reconciliation'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { PrioritySemaphore } from '../../../../shared/priority-semaphore'
import {
  notifyLocalWatcherEvents,
  notifyLocalWatcherInterrupted
} from './local-watcher-event-observers'

// All local and WSL roots in main share this budget; watcher children have separate pools.
const DIRECTORY_STAT_CONCURRENCY = 8
const directoryStatSlots = new PrioritySemaphore(DIRECTORY_STAT_CONCURRENCY)

async function tryStatIsDirectory(
  filePath: string,
  root: WatchedRoot
): Promise<boolean | undefined> {
  const signal = root.batch.statAbortController.signal
  try {
    const release = await directoryStatSlots.acquire(0, signal)
    try {
      // Cancellation can race with a slot grant before this continuation resumes.
      signal.throwIfAborted()
      if (root.listeners.size === 0) {
        return undefined
      }
      return (await stat(filePath)).isDirectory()
    } finally {
      release()
    }
  } catch {
    // Failed stat leaves the renderer's conservative file-event default.
    return undefined
  }
}

function emitOverflowPayload(root: WatchedRoot): void {
  const { rootPath } = root
  const payload: FsChangedPayload = {
    worktreePath: rootPath,
    events: [{ kind: 'overflow', absolutePath: rootPath }]
  }
  for (const [, wc] of root.listeners) {
    if (!wc.isDestroyed()) {
      wc.send('fs:changed', payload)
    }
  }
}

async function flushBatch(root: WatchedRoot): Promise<void> {
  if (root.batch.cancelled) {
    return
  }
  if (root.batch.flushInFlight) {
    root.batch.flushQueued = true
    return
  }

  root.batch.flushInFlight = true
  if (root.batch.timer) {
    clearTimeout(root.batch.timer)
    root.batch.timer = null
  }
  const overflowed = root.batch.overflowed
  const rawEvents = root.batch.events.splice(0)
  root.batch.overflowed = false
  root.batch.lastFlushAt = Date.now()

  try {
    if (
      (rawEvents.length === 0 && !overflowed) ||
      (root.listeners.size === 0 && root.indexConsumers.size === 0)
    ) {
      return
    }

    if (overflowed || rawEvents.length > MAX_BATCHED_WATCHER_EVENTS) {
      // Why: an overflow means events were lost, so the cached path set can no longer be trusted.
      invalidateQuickOpenPathInventory(root.rootPath, 'watcher-overflow', rawEvents.length)
      root.batch.indexReconciliationMarked = false
      // Why: deletion storms can be too large to coalesce/stat per path; one overflow asks the renderer for the same conservative refresh.
      if (!root.batch.cancelled) {
        emitOverflowPayload(root)
      }
      return
    }

    const coalesced = coalesceEvents(rawEvents)

    // Bound stat concurrency so Git and persistence can still use libuv's shared pool.
    const events: FsChangeEvent[] = await mapWithConcurrency(
      coalesced,
      DIRECTORY_STAT_CONCURRENCY,
      async (evt) => {
        // Deleted paths cannot be statted; let the renderer infer from dirCache.
        const isDirectory =
          root.batch.cancelled || root.listeners.size === 0 || evt.type === 'delete'
            ? undefined
            : await tryStatIsDirectory(evt.path, root)

        return {
          kind: evt.type,
          absolutePath: evt.path,
          isDirectory
        }
      }
    )

    if (root.batch.cancelled || (root.listeners.size === 0 && root.indexConsumers.size === 0)) {
      return
    }

    const indexEvents = events.filter(needsWorkspacePathIndexReconciliation)
    if (indexEvents.some(isWorkspacePathIndexPolicyEvent)) {
      invalidateQuickOpenPathInventory(root.rootPath, 'ignore-policy-change', indexEvents.length)
      root.batch.indexReconciliationMarked = false
    } else if (indexEvents.length > 0) {
      const finishReconciliation =
        root.batch.events.length === 0 &&
        !root.batch.overflowed &&
        !root.batch.flushQueued &&
        !root.batch.timer
      root.indexReconciliationPromise = root.indexReconciliationPromise
        .then(() =>
          reconcileLocalWorkspacePathIndexEvents(
            root.rootPath,
            indexEvents,
            finishReconciliation,
            root.indexReconciliationController.signal,
            root.eventSequence
          )
        )
        .catch(() => undefined)
      if (finishReconciliation) {
        root.batch.indexReconciliationMarked = false
      }
    } else if (root.batch.indexReconciliationMarked) {
      const finishReconciliation =
        root.batch.events.length === 0 &&
        !root.batch.overflowed &&
        !root.batch.flushQueued &&
        !root.batch.timer
      if (finishReconciliation) {
        completeLocalWorkspacePathIndexReconciliation(root.rootPath)
        root.batch.indexReconciliationMarked = false
      }
    }

    const payload: FsChangedPayload = {
      worktreePath: root.rootPath,
      events
    }

    for (const [, wc] of root.listeners) {
      if (!wc.isDestroyed()) {
        wc.send('fs:changed', payload)
      }
    }
  } finally {
    root.batch.flushInFlight = false
    if (root.batch.flushQueued) {
      root.batch.flushQueued = false
      if (
        !root.batch.cancelled &&
        // An armed flush still owns its window; draining early would split related events.
        !root.batch.timer &&
        (root.batch.events.length > 0 || root.batch.overflowed)
      ) {
        // Drain after the current payload settles to preserve event order and the storm tail.
        void flushBatch(root)
      }
    }
  }
}

export function scheduleLocalBatchFlush(root: WatchedRoot): void {
  if (root.batch.cancelled) {
    return
  }
  if (root.batch.flushInFlight) {
    root.batch.flushQueued = true
  }

  // Resetting armed timers would starve delivery under continuous writes.
  if (root.batch.timer) {
    return
  }
  // Null the fired timer so queued drain sees that the flush window closed.
  root.batch.timer = setTimeout(
    () => {
      root.batch.timer = null
      void flushBatch(root)
    },
    watchBatchFlushDelayMs(Date.now(), root.batch.lastFlushAt)
  )
}

export async function createLocalWatcher(
  rootKey: string,
  rootPath: string,
  signal?: AbortSignal
): Promise<WatchedRoot> {
  const root: WatchedRoot = {
    subscription: null!,
    listeners: new Map(),
    indexConsumers: new Set(),
    batch: createDebouncedBatch(),
    eventSequence: 0,
    indexReconciliationPromise: Promise.resolve(),
    indexReconciliationController: new AbortController(),
    indexCoverageTimer: null,
    rootPath
  }

  try {
    // Errors can precede subscribe resolution; retain cleanup evidence to retire the orphan handle.
    let errorCleanedUp = false

    const watcherOptions = {
      ...buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS),
      // Pin Windows backend to avoid Parcel's noisy Watchman probe.
      ...(process.platform === 'win32' ? { backend: 'windows' as const } : {})
    }

    const markWatcherInterrupted = (): void => {
      invalidateQuickOpenPathInventory(
        root.rootPath,
        'watcher-interruption',
        root.batch.events.length
      )
      root.batch.indexReconciliationMarked = false
      notifyLocalWatcherInterrupted(root)
      root.batch.overflowed = true
      scheduleLocalBatchFlush(root)
    }

    // Isolate watcher.node teardown crashes in a child; interruptions require overflow refresh (#7547).
    root.subscription = await subscribeViaWatcherProcess(
      rootPath,
      (err, events) => {
        if (err) {
          invalidateQuickOpenPathInventory(root.rootPath, 'watcher-error')
          // Why: treat watcher errors as overflow so the renderer conservatively refreshes rather than trusting possibly-invalid caches (§7.2, §7.3).
          console.error(`[filesystem-watcher] error for ${rootKey}:`, err)
          notifyLocalWatcherInterrupted(root)
          emitOverflowPayload(root)
          // Retire native subscriptions that may be invalid after errors or root deletion.
          cancelLocalBatchFlush(root)
          // The error callback can precede assignment of the subscription.
          if (root.subscription) {
            retainLocalWatcherPhysicalFailure(rootKey, err)
            void trackDetachedLocalUnsubscribe(rootKey, root)
          }
          errorCleanedUp = true
          watcherLifecycleState.watchedRoots.delete(rootKey)
          return
        }

        if (root.batch.cancelled) {
          return
        }
        root.eventSequence += events?.length ?? 0
        const relevantEvents = events?.filter(
          (watcherEvent) =>
            watcherEvent.type !== 'update' || isWorkspacePathIndexPolicyPath(watcherEvent.path)
        )
        if (!root.batch.indexReconciliationMarked && (relevantEvents?.length ?? 0) > 0) {
          root.batch.indexReconciliationMarked = true
          beginLocalWorkspacePathIndexReconciliation(root.rootPath, relevantEvents?.length ?? 0)
        }
        notifyLocalWatcherEvents(root, events)
        queueWatcherEvents(root.batch, events)
        scheduleLocalBatchFlush(root)
      },
      watcherOptions,
      {
        delivery: { maxEventsPerBatch: MAX_BATCHED_WATCHER_EVENTS },
        // A child restart or bounded-queue overflow loses path precision; both need the same conservative renderer refresh.
        onInterruption: markWatcherInterrupted,
        onOverflow: markWatcherInterrupted,
        signal
      }
    )

    // subscribe resolved after error cleanup; retire its orphaned native handle.
    if (errorCleanedUp) {
      void trackDetachedLocalUnsubscribe(rootKey, root)
      throw new Error(`Watcher for ${rootKey} errored during subscribe`)
    }
  } catch (err) {
    // Surface synchronous subscription failures through the caller rather than crashing main.
    console.error(`[filesystem-watcher] failed to subscribe ${rootKey}:`, err)
    throw err
  }

  return root
}
