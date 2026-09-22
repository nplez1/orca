import type { Store } from '../persistence'
import {
  isQuickOpenInventoryOverBudget,
  QUICK_OPEN_INVENTORY_MAX_PATHS,
  QUICK_OPEN_INVENTORY_REBUILD_DEBOUNCE_MS,
  QUICK_OPEN_INVENTORY_TTL_MS
} from '../../shared/quick-open-path-inventory-limits'
import {
  buildExcludePathPrefixes,
  shouldExcludeQuickOpenRelPath
} from '../../shared/quick-open-filter'
import {
  isQuickOpenQueryTooLarge,
  NameFilterPathMatcher
} from '../../shared/quick-open-path-search'
import { collectQuickOpenPaths } from './filesystem-search-file-paths'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'

/**
 * Host-side path inventory for the Explore name filter.
 *
 * A filtered query only needs file names, so re-walking the workspace per keystroke is pure
 * waste: the walk is the whole cost and matching is trivial. This keeps one path list per
 * workspace root in the main process — `included` (the Contents-tab scope, gitignore-aware) and
 * `all` (the `--no-ignore-vcs` superset a pane showing gitignored files needs) — and answers
 * queries from memory. The local watcher drops the entry when the path set changes and a
 * debounced build re-warms it; past the memory budget the entry is dropped and callers fall back
 * to the existing live scan.
 *
 * A missing entry means "not warmed", never "no matches": every `null` here is a directive to
 * scan live.
 */

export type QuickOpenPathInventoryMatch = {
  paths: string[]
  totalCount: number
  truncated: boolean
  /** Subset of `paths` git ignores; empty unless the query included ignored files. */
  ignoredPaths: string[]
}

type InventoryEntry = {
  rootPath: string
  store: Store
  /** Authorized root captured at build time, for resolving per-query exclude prefixes. */
  authorizedRootPath: string | null
  included: string[]
  includedSet: Set<string>
  all: string[] | null
  retainedPathBytes: number
  builtAt: number
  needsRebuild: boolean
  unsupported: boolean
  buildPromise: Promise<void> | null
  rebuildTimer: ReturnType<typeof setTimeout> | null
  rebuildGeneration: number
  lastBuildFailed: boolean
}

const entries = new Map<string, InventoryEntry>()

function inventoryKey(rootPath: string): string {
  return getLocalWatcherRoot(rootPath).key
}

// Why: a JS string costs ~2 bytes/char plus a per-string header and an array slot, so a bare
// character count undercounts retained heap by roughly 2-3x.
const PATH_RETAINED_OVERHEAD_BYTES = 48

function totalRetainedPathBytes(paths: readonly string[]): number {
  let total = 0
  for (const path of paths) {
    total += path.length * 2 + PATH_RETAINED_OVERHEAD_BYTES
  }
  return total
}

function markUnsupported(entry: InventoryEntry): void {
  if (!entry.unsupported) {
    // Why: a silent drop would read as "the workspace has no such file" on a huge repo.
    console.warn(
      `[quick-open-inventory] workspace exceeds the path index budget; falling back to live scans: ${entry.rootPath}`
    )
  }
  entry.unsupported = true
  entry.included = []
  entry.includedSet = new Set()
  entry.all = null
  entry.retainedPathBytes = 0
  entry.needsRebuild = false
}

async function buildEntry(entry: InventoryEntry, generation: number): Promise<void> {
  const included = await collectQuickOpenPaths(entry.rootPath, entry.store, {
    pass: 'included',
    maxPaths: QUICK_OPEN_INVENTORY_MAX_PATHS
  })
  if (included.budgetExceeded) {
    markUnsupported(entry)
    return
  }
  const all = await collectQuickOpenPaths(entry.rootPath, entry.store, {
    pass: 'all',
    maxPaths: QUICK_OPEN_INVENTORY_MAX_PATHS
  })
  const retainedPathBytes =
    totalRetainedPathBytes(included.paths) + totalRetainedPathBytes(all.paths)
  if (all.budgetExceeded || isQuickOpenInventoryOverBudget(all.paths.length, retainedPathBytes)) {
    markUnsupported(entry)
    return
  }
  entry.authorizedRootPath = included.authorizedRootPath
  entry.included = included.paths
  entry.includedSet = new Set(included.paths)
  entry.all = all.paths
  entry.retainedPathBytes = retainedPathBytes
  entry.builtAt = Date.now()
  // Why: an invalidation that landed mid-build owns the next rebuild; this build must not clear it.
  if (entry.rebuildGeneration === generation) {
    entry.needsRebuild = false
  }
}

function scheduleRebuildTimer(entry: InventoryEntry): void {
  if (entry.rebuildTimer || entry.unsupported) {
    return
  }
  entry.rebuildTimer = setTimeout(() => {
    entry.rebuildTimer = null
    void startBuild(entry)
  }, QUICK_OPEN_INVENTORY_REBUILD_DEBOUNCE_MS)
}

function startBuild(entry: InventoryEntry): Promise<void> {
  if (entry.buildPromise) {
    return entry.buildPromise
  }
  const generation = entry.rebuildGeneration
  const promise = buildEntry(entry, generation)
    .catch((error) => {
      // Why: a failed walk must not leave a half-built entry that reads as complete.
      entry.needsRebuild = true
      entry.lastBuildFailed = true
      console.warn(`[quick-open-inventory] build failed for ${entry.rootPath}:`, error)
    })
    .finally(() => {
      if (entry.buildPromise === promise) {
        entry.buildPromise = null
      }
      // Why: an invalidation that landed mid-build still owes a rebuild, but a failed build must
      // not auto-retry — that would spawn ripgrep in a loop until the next user query.
      if (entry.needsRebuild && !entry.unsupported && !entry.lastBuildFailed) {
        scheduleRebuildTimer(entry)
      }
      entry.lastBuildFailed = false
    })
  entry.buildPromise = promise
  return promise
}

function requestRebuild(entry: InventoryEntry): void {
  entry.rebuildGeneration += 1
  entry.needsRebuild = true
  scheduleRebuildTimer(entry)
}

function isStale(entry: InventoryEntry, now: number): boolean {
  return now - entry.builtAt > QUICK_OPEN_INVENTORY_TTL_MS
}

function getEntry(rootPath: string, store: Store): InventoryEntry {
  const key = inventoryKey(rootPath)
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      rootPath,
      store,
      authorizedRootPath: null,
      included: [],
      includedSet: new Set(),
      all: null,
      retainedPathBytes: 0,
      builtAt: 0,
      needsRebuild: true,
      unsupported: false,
      buildPromise: null,
      rebuildTimer: null,
      rebuildGeneration: 0,
      lastBuildFailed: false
    }
    entries.set(key, entry)
  }
  entry.store = store
  return entry
}

/** Warm the index off the interactive path; a filter keystroke must never pay for the walk. */
export function prewarmQuickOpenPathInventory(rootPath: string, store: Store): void {
  const entry = getEntry(rootPath, store)
  if (entry.unsupported || entry.buildPromise) {
    return
  }
  if (!entry.needsRebuild && !isStale(entry, Date.now())) {
    return
  }
  void startBuild(entry)
}

export async function queryQuickOpenPathInventory(
  rootPath: string,
  store: Store,
  args: {
    query: string
    limit: number
    excludePaths?: string[]
    includeIgnoredFiles: boolean
  }
): Promise<QuickOpenPathInventoryMatch | null> {
  const entry = entries.get(inventoryKey(rootPath))
  if (!entry) {
    return null
  }
  entry.store = store
  if (
    entry.unsupported ||
    args.limit <= 0 ||
    !args.query.trim() ||
    isQuickOpenQueryTooLarge(args.query)
  ) {
    return null
  }
  // Why: wait out an in-flight warm rather than duplicating its walk with a live scan. A failed
  // or budget-dropped build leaves the entry unusable, so bail to the live path below.
  if (entry.buildPromise) {
    await entry.buildPromise
  }
  if (entry.unsupported) {
    return null
  }
  if (entry.needsRebuild || isStale(entry, Date.now()) || entry.authorizedRootPath === null) {
    requestRebuild(entry)
    return null
  }
  const candidates = args.includeIgnoredFiles ? entry.all : entry.included
  if (candidates === null) {
    requestRebuild(entry)
    return null
  }
  const excludePrefixes = buildExcludePathPrefixes(entry.authorizedRootPath, args.excludePaths)
  const matcher = new NameFilterPathMatcher(args.query, args.limit)
  for (const path of candidates) {
    if (shouldExcludeQuickOpenRelPath(path, excludePrefixes)) {
      continue
    }
    matcher.consider(path)
  }
  const { paths, totalCount } = matcher.result()
  return {
    paths,
    totalCount,
    truncated: totalCount > args.limit,
    ignoredPaths: args.includeIgnoredFiles
      ? paths.filter((path) => !entry.includedSet.has(path))
      : []
  }
}

/** Drop cached paths when the watcher reports the path set changed; the rebuild is debounced. */
export function invalidateQuickOpenPathInventory(rootPath: string): void {
  const entry = entries.get(inventoryKey(rootPath))
  if (!entry) {
    return
  }
  requestRebuild(entry)
}

export function evictQuickOpenPathInventory(rootPath: string): void {
  const key = inventoryKey(rootPath)
  const entry = entries.get(key)
  if (!entry) {
    return
  }
  if (entry.rebuildTimer) {
    clearTimeout(entry.rebuildTimer)
  }
  entries.delete(key)
}

/** Drop every warm index (watcher shutdown, and between tests). */
export function clearQuickOpenPathInventories(): void {
  for (const entry of entries.values()) {
    if (entry.rebuildTimer) {
      clearTimeout(entry.rebuildTimer)
    }
  }
  entries.clear()
}
