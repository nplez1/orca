/**
 * Bounds for the host-side path inventory that answers Explore name-filter queries from
 * memory instead of re-walking the workspace per keystroke.
 *
 * Separate from `QUICK_OPEN_LISTING_MAX_RESULTS`: that is a per-listing OOM bound, this is a
 * cache bound. Exceeding it drops the cache and degrades to the existing live scan — it never
 * truncates a result, so the pane's totals stay honest.
 */

export const QUICK_OPEN_INVENTORY_MAX_PATHS = 1_500_000
/** Approximate retained heap for the cached path lists (characters plus per-path overhead). */
export const QUICK_OPEN_INVENTORY_MAX_PATH_BYTES = 128 * 1024 * 1024
/** Safety net for watcher events the host never sees; the watcher invalidates far sooner. */
export const QUICK_OPEN_INVENTORY_TTL_MS = 60_000
/** Delay after a watcher flush so an edit storm coalesces into one re-walk. */
export const QUICK_OPEN_INVENTORY_REBUILD_DEBOUNCE_MS = 400

export function isQuickOpenInventoryOverBudget(
  pathCount: number,
  retainedPathBytes: number
): boolean {
  return (
    pathCount > QUICK_OPEN_INVENTORY_MAX_PATHS ||
    retainedPathBytes > QUICK_OPEN_INVENTORY_MAX_PATH_BYTES
  )
}
