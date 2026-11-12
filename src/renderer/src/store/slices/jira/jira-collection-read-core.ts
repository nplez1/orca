import { normalizeJiraStatusSelection } from '../../../../../shared/jira/jira-quick-filters'
import type {
  JiraIssue,
  JiraIssueListFilters,
  JiraIssueSearchContinuation,
  JiraIssueSearchPage,
  JiraSiteSelection
} from '../../../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { JiraSearchCacheEntry, JiraSliceGet, JiraSliceSet } from './jira-slice-contract'
import {
  createJiraAbortError,
  currentJiraMutationGeneration,
  evictStaleJiraCacheEntries,
  isFreshJiraCacheEntry,
  registerJiraPageInflightReset,
  scopedJiraCacheKey,
  shouldRefreshJiraStatusAfterRead,
  type InflightJiraReadRequest,
  type JiraReadScope
} from './jira-read-coordination'

export const EMPTY_ISSUE_PAGE: JiraIssueSearchPage = {
  issues: [],
  hasMore: false,
  total: null,
  continuation: null
}

/** Page reads dedupe among themselves: an array caller expects `JiraIssue[]`, and a page
 *  caller needs metadata an array entry never carries. */
export const inflightSearchPageRequests = new Map<
  string,
  InflightJiraReadRequest<JiraIssueSearchPage>
>()
export const inflightListPageRequests = new Map<
  string,
  InflightJiraReadRequest<JiraIssueSearchPage>
>()
registerJiraPageInflightReset(() => {
  inflightSearchPageRequests.clear()
  inflightListPageRequests.clear()
})

/** The routing a read needs, resolved by the module that owns it so a read never has to. */
export type JiraCollectionReadGate = {
  scope: JiraReadScope
  /** Whether this result may still be written back. */
  canWrite: () => boolean
  /** Records a failure for its side effects, and rethrows the ones that are not about auth. */
  recordFailure: (
    error: unknown,
    siteId: JiraSiteSelection | null | undefined,
    options: { abortable?: boolean; currentRequest: boolean }
  ) => void
}

export type JiraCollectionReadGateFactory = (
  sourceContext: TaskSourceContext | null | undefined
) => JiraCollectionReadGate

export type CollectionReadOptions = {
  force?: boolean
  signal?: AbortSignal
}

export type CollectionRead<T> = {
  cacheKey: string
  inflight: Map<string, InflightJiraReadRequest<T>>
  gate: JiraCollectionReadGate
  siteId: JiraSiteSelection | null | undefined
  options: CollectionReadOptions
  read: () => Promise<T>
  empty: T
  fromCache: (entry: JiraSearchCacheEntry) => T | null
  toCacheEntry: (value: T) => JiraSearchCacheEntry
}

/** The cache, dedupe, failure and status-refresh path every collection read shares. */
export async function readCollection<T>(
  args: CollectionRead<T>,
  set: JiraSliceSet,
  get: JiraSliceGet
): Promise<T> {
  const { cacheKey, inflight, gate, siteId, options, read } = args
  const abortable = options.signal !== undefined
  const force = options.force === true
  const cached = get().jiraSearchCache[cacheKey]
  if (!force && isFreshJiraCacheEntry(cached)) {
    const hit = args.fromCache(cached)
    if (hit !== null) {
      return hit
    }
  }
  const mutationGeneration = currentJiraMutationGeneration()
  const shared = inflight.get(cacheKey)
  if (
    !force &&
    !abortable &&
    shared &&
    shared.contextKey === gate.scope.contextKey &&
    shared.mutationGeneration === mutationGeneration
  ) {
    return shared.promise
  }
  let entry: InflightJiraReadRequest<T>
  const promise = read()
    .then((value) => {
      if (options.signal?.aborted) {
        throw createJiraAbortError('search')
      }
      if ((abortable || inflight.get(cacheKey) === entry) && gate.canWrite()) {
        const next = args.toCacheEntry(value)
        set((state) => ({
          jiraSearchCache: evictStaleJiraCacheEntries({
            ...state.jiraSearchCache,
            [cacheKey]: next
          })
        }))
      }
      return value
    })
    .catch((error) => {
      if (options.signal?.aborted) {
        throw error
      }
      console.warn('[jira] jira collection read failed:', error)
      gate.recordFailure(error, siteId, {
        abortable,
        currentRequest: abortable || inflight.get(cacheKey) === entry
      })
      return args.empty
    })
    .finally(() => {
      if (inflight.get(cacheKey) === entry) {
        inflight.delete(cacheKey)
      }
      if (
        !options.signal?.aborted &&
        shouldRefreshJiraStatusAfterRead(siteId, get().jiraStatus, { abortable }) &&
        gate.canWrite()
      ) {
        void get().checkJiraConnection()
      }
    })
  entry = { promise, contextKey: gate.scope.contextKey, mutationGeneration }
  if (!abortable) {
    inflight.set(cacheKey, entry)
  }
  return promise
}

export const cachedIssues = (entry: JiraSearchCacheEntry): JiraIssue[] => entry.data ?? []
export const cachedPage = (entry: JiraSearchCacheEntry): JiraIssueSearchPage | null =>
  entry.page ? { issues: entry.data ?? [], ...entry.page } : null
export const issuesEntry = (issues: JiraIssue[]): JiraSearchCacheEntry => ({
  data: issues,
  fetchedAt: Date.now()
})
export const pageEntry = (page: JiraIssueSearchPage): JiraSearchCacheEntry => ({
  data: page.issues,
  page: { hasMore: page.hasMore, total: page.total, continuation: page.continuation },
  fetchedAt: Date.now()
})

export function listFilters(filters?: JiraIssueListFilters): JiraIssueListFilters | undefined {
  const statuses = normalizeJiraStatusSelection(filters?.statuses).sort()
  const currentSprint = filters?.currentSprint === true
  return statuses.length || currentSprint
    ? {
        ...(statuses.length ? { statuses } : {}),
        ...(currentSprint ? { currentSprint: true } : {})
      }
    : undefined
}

/** The cache key a collection read shares with the array reads of the same query. */
export function collectionKey(
  scope: JiraReadScope,
  subject: string,
  siteId: JiraSiteSelection | null | undefined,
  limit: number,
  filters: JiraIssueListFilters | undefined
): string {
  const query = filters ? `${subject}${`::${JSON.stringify(filters)}`}` : subject
  return scopedJiraCacheKey(scope, `${siteId ?? 'default'}::${query}::${limit}`)
}

/** A rendered view's page has no reader, only patchers, so it gets a key nothing asks for. */
export function pageCacheKey(
  scope: JiraReadScope,
  continuation: JiraIssueSearchContinuation,
  limit: number
): string {
  const cursor = continuation.pageToken ?? `start:${continuation.startAt}`
  return scopedJiraCacheKey(
    scope,
    `${continuation.siteId}::${continuation.jql}::${limit}::page::${cursor}`
  )
}
