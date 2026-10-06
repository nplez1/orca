import type { Worktree } from '../../../../shared/worktree/types'
import {
  projectPendingWorktreeRemovals,
  type PendingWorktreeRemovals
} from '../../../worktree-background-removal'

export const WORKTREE_LIST_ALL_CONCURRENCY = 8

// Why always marked: the desktop renderer ships with this main process, so it reads the marker.
export function markLocalWorktreesUnderRemoval<T extends Worktree>(
  worktrees: T[],
  pendingAtScan: PendingWorktreeRemovals
): T[] {
  return projectPendingWorktreeRemovals(worktrees, (worktree) => worktree.id, true, pendingAtScan)
}

/** Runs `fn` over every item with at most `limit` in flight, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await fn(items[index])
      }
    })
  )
  return results
}
