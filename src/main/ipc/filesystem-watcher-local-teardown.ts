import type { WatchedRoot } from './filesystem-watcher-wsl'
import {
  WATCHER_TEARDOWN_GRACE_MS,
  watcherLifecycleState
} from './filesystem-watcher-lifecycle-state'
import { trackDetachedLocalUnsubscribe } from './filesystem-watcher-listener-lifecycle'
import { cancelLocalBatchFlush } from './filesystem-watcher-batch-control'
import { evictQuickOpenPathInventory } from './quick-open-path-inventory'

/**
 * Defer a local watcher's teardown until the grace window closes.
 *
 * Why its own module: extracted from `filesystem-watcher-local-subscription.ts` to keep that file
 * under the max-lines budget.
 */
export function scheduleLocalWatcherTeardown(rootKey: string, root: WatchedRoot): void {
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
