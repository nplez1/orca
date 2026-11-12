import {
  jiraListIssuesPageForTarget,
  jiraSearchIssuesPage
} from '@/runtime/jira/runtime-jira-client'
import { getJiraRuntimeTarget } from '@/runtime/jira/runtime-jira-target'
import type { JiraIssueListFilters, JiraSiteSelection } from '../../../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { JiraSlice, JiraSliceGet, JiraSliceSet } from './jira-slice-contract'
import {
  EMPTY_ISSUE_PAGE,
  cachedPage,
  collectionKey,
  inflightListPageRequests,
  inflightSearchPageRequests,
  issuesEntry,
  listFilters,
  pageCacheKey,
  pageEntry,
  readCollection,
  type JiraCollectionReadGateFactory
} from './jira-collection-read-core'
import {
  evictStaleJiraCacheEntries,
  getSelectedJiraSiteId,
  shouldRefreshJiraStatusAfterRead
} from './jira-read-coordination'

type JiraCollectionPageReadActions = Pick<
  JiraSlice,
  'searchJiraIssuePage' | 'listJiraIssuePage' | 'loadMoreJiraIssues'
>

type PageReadOptions = {
  sourceContext?: TaskSourceContext | null
  force?: boolean
  signal?: AbortSignal
  siteId?: JiraSiteSelection | null
  filters?: JiraIssueListFilters
}

/** The list's paged reads. The gate comes from the module that owns the routing, so a read
 *  never resolves a host itself. */
export function createJiraCollectionPageReadActions(
  set: JiraSliceSet,
  get: JiraSliceGet,
  gateFor: JiraCollectionReadGateFactory
): JiraCollectionPageReadActions {
  const target = (
    kind: 'search' | 'list',
    value: string,
    limit: number,
    options: PageReadOptions
  ): {
    gate: ReturnType<JiraCollectionReadGateFactory>
    siteId: JiraSiteSelection | null | undefined
    filters: JiraIssueListFilters | undefined
    cacheKey: string
  } => {
    const gate = gateFor(options.sourceContext)
    const siteId =
      kind === 'search' && 'siteId' in options
        ? options.siteId
        : getSelectedJiraSiteId(get().jiraStatus)
    const filters = kind === 'list' ? listFilters(options.filters) : undefined
    const subject = kind === 'search' ? value : `list::${value}`
    return {
      gate,
      siteId,
      filters,
      cacheKey: collectionKey(gate.scope, subject, siteId, limit, filters)
    }
  }

  return {
    searchJiraIssuePage: async (jql, limit = 30, options = {}) => {
      const t = target('search', jql, limit, options)
      return readCollection(
        {
          ...t,
          inflight: inflightSearchPageRequests,
          options,
          read: () =>
            jiraSearchIssuesPage(t.gate.scope.settings, jql, limit, t.siteId, options.signal),
          empty: EMPTY_ISSUE_PAGE,
          fromCache: cachedPage,
          toCacheEntry: pageEntry
        },
        set,
        get
      )
    },

    listJiraIssuePage: async (filter = 'assigned', limit = 30, options = {}) => {
      const t = target('list', filter, limit, options)
      return readCollection(
        {
          ...t,
          inflight: inflightListPageRequests,
          options,
          read: () =>
            jiraListIssuesPageForTarget(
              getJiraRuntimeTarget(t.gate.scope.settings),
              filter,
              limit,
              t.siteId,
              t.filters
            ),
          empty: EMPTY_ISSUE_PAGE,
          fromCache: cachedPage,
          toCacheEntry: pageEntry
        },
        set,
        get
      )
    },

    loadMoreJiraIssues: async (continuation, limit = 30, options = {}) => {
      const gate = gateFor(options.sourceContext)
      return jiraSearchIssuesPage(
        gate.scope.settings,
        continuation.jql,
        limit,
        continuation.siteId,
        options.signal,
        { pageToken: continuation.pageToken, startAt: continuation.startAt }
      )
        .then((page) => {
          if (gate.canWrite()) {
            // Why the cache at all: it is the surface `patchJiraIssue` updates, so an appended
            // row has to be findable there or a board move would leave it stale.
            set((state) => ({
              jiraSearchCache: evictStaleJiraCacheEntries({
                ...state.jiraSearchCache,
                [pageCacheKey(gate.scope, continuation, limit)]: issuesEntry(page.issues)
              })
            }))
          }
          return page
        })
        .catch((error) => {
          console.warn('[jira] loadMoreJiraIssues failed:', error)
          // Why rethrow after recording: an auth failure here must not read as the end of the
          // list, so the footer keeps its page and offers the retry instead.
          gate.recordFailure(error, continuation.siteId, { currentRequest: true })
          throw error
        })
        .finally(() => {
          if (
            shouldRefreshJiraStatusAfterRead(continuation.siteId, get().jiraStatus) &&
            gate.canWrite()
          ) {
            void get().checkJiraConnection()
          }
        })
    }
  }
}
