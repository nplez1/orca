import type { JiraBoardOverview, JiraIssue } from '../../../shared/jira-types'

// Why: board reads are paged Jira agile calls that cost several round-trips, so the
// board keeps its last snapshot in memory. Returning to the board renders this
// snapshot immediately and revalidates behind it instead of flashing a loader.
export const TASK_PAGE_JIRA_BOARD_CACHE_TTL_MS = 30 * 60_000
export const TASK_PAGE_JIRA_BOARD_CACHE_MAX_ENTRIES = 3

export type TaskPageJiraBoardCachedPage = {
  issues: JiraIssue[]
  startAt: number
  pageToken: string | null
  isLast: boolean
  total: number | null
}

export type TaskPageJiraBoardCacheEntry = {
  overview: JiraBoardOverview | null
  activeSprintId: string
  /** null until a page fetch has completed for that scope, so "no snapshot" stays distinguishable from "empty board". */
  sprint: TaskPageJiraBoardCachedPage | null
  backlog: TaskPageJiraBoardCachedPage | null
  cachedAt: number
}

export type TaskPageJiraBoardCachePatch = Partial<Omit<TaskPageJiraBoardCacheEntry, 'cachedAt'>>

function emptyTaskPageJiraBoardCacheEntry(now: number): TaskPageJiraBoardCacheEntry {
  return {
    overview: null,
    activeSprintId: '',
    sprint: null,
    backlog: null,
    cachedAt: now
  }
}

export function taskPageJiraBoardCacheKey(selection: { siteId: string; boardId: string }): string {
  return `${selection.siteId}\u0000${selection.boardId}`
}

const entries = new Map<string, TaskPageJiraBoardCacheEntry>()

function pruneExpired(now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.cachedAt >= TASK_PAGE_JIRA_BOARD_CACHE_TTL_MS) {
      entries.delete(key)
    }
  }
}

export function readTaskPageJiraBoardCache(
  key: string,
  now: number = Date.now()
): TaskPageJiraBoardCacheEntry | null {
  pruneExpired(now)
  const entry = entries.get(key)
  if (!entry) {
    return null
  }
  // Recency order for eviction; re-insert so the most recently read board survives.
  entries.delete(key)
  entries.set(key, entry)
  return {
    ...entry,
    sprint: entry.sprint ? { ...entry.sprint, issues: [...entry.sprint.issues] } : null,
    backlog: entry.backlog ? { ...entry.backlog, issues: [...entry.backlog.issues] } : null
  }
}

export function patchTaskPageJiraBoardCache(
  key: string,
  patch: TaskPageJiraBoardCachePatch,
  now: number = Date.now()
): void {
  pruneExpired(now)
  const current = entries.get(key) ?? emptyTaskPageJiraBoardCacheEntry(now)
  entries.delete(key)
  entries.set(key, { ...current, ...patch, cachedAt: now })
  while (entries.size > TASK_PAGE_JIRA_BOARD_CACHE_MAX_ENTRIES) {
    const oldestKey = entries.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    entries.delete(oldestKey)
  }
}

export function clearTaskPageJiraBoardCache(): void {
  entries.clear()
}

export function taskPageJiraBoardCacheSize(): number {
  return entries.size
}
