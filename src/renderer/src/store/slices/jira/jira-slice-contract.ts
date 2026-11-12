import type { StateCreator } from 'zustand'
import type { CacheEntry } from '../../github/cache/cache-model'
import type { AppState } from '../../types'
import type {
  JiraAuthType,
  JiraConnectionStatus,
  JiraIssue,
  JiraIssueFilter,
  JiraIssueListFilters,
  JiraIssueSearchContinuation,
  JiraIssueSearchPage,
  JiraSiteSelection,
  JiraViewer
} from '../../../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'

export type JiraReadOptions = {
  sourceContext?: TaskSourceContext | null
  siteId?: JiraSiteSelection | null
}

export type JiraCollectionReadOptions = JiraReadOptions & {
  force?: boolean
  filters?: JiraIssueListFilters
}
export type JiraSearchOptions = JiraCollectionReadOptions & { signal?: AbortSignal }
export type JiraPatchOptions = {
  sourceContext?: TaskSourceContext | null
  siteId?: string | null
  contextKey?: string
}
export type JiraIssueSummaryLookupOptions = { force?: boolean; signal?: AbortSignal }

/** The part of a page that a cached issue array cannot carry on its own. */
export type JiraIssueSearchPageMeta = Omit<JiraIssueSearchPage, 'issues'>
/** A page read and an array read share a cache key, so only an entry carrying `page`
 *  can answer a page read; the metadata is what makes the two shapes distinguishable. */
export type JiraSearchCacheEntry = CacheEntry<JiraIssue[]> & { page?: JiraIssueSearchPageMeta }

export type JiraSlice = {
  jiraStatus: JiraConnectionStatus
  jiraStatusChecked: boolean
  jiraStatusContextKey: string | null
  jiraConnectionRevisions: Record<string, number>
  jiraIssueCache: Record<string, CacheEntry<JiraIssue>>
  jiraIssueSummaryCache: Record<string, CacheEntry<JiraIssue | null>>
  jiraSearchCache: Record<string, JiraSearchCacheEntry>

  checkJiraConnection: () => Promise<void>
  readJiraStatus: (sourceContext: TaskSourceContext) => Promise<JiraConnectionStatus>
  lookupJiraIssueSummary: (
    sourceContext: TaskSourceContext,
    key: string,
    siteId: string,
    options?: JiraIssueSummaryLookupOptions
  ) => Promise<JiraIssue | null>
  connectJira: (args: {
    siteUrl: string
    email: string
    apiToken: string
    authType?: JiraAuthType
  }) => Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }>
  testJiraConnection: (
    siteId?: string | null
  ) => Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }>
  selectJiraSite: (siteId: JiraSiteSelection) => Promise<void>
  disconnectJira: (siteId?: string | null) => Promise<void>
  fetchJiraIssue: (
    key: string,
    siteId?: string | null,
    options?: JiraReadOptions
  ) => Promise<JiraIssue | null>
  searchJiraIssues: (
    jql: string,
    limit?: number,
    options?: JiraSearchOptions
  ) => Promise<JiraIssue[]>
  listJiraIssues: (
    filter?: JiraIssueFilter,
    limit?: number,
    options?: JiraCollectionReadOptions
  ) => Promise<JiraIssue[]>
  searchJiraIssuePage: (
    jql: string,
    limit?: number,
    options?: JiraSearchOptions
  ) => Promise<JiraIssueSearchPage>
  listJiraIssuePage: (
    filter?: JiraIssueFilter,
    limit?: number,
    options?: JiraCollectionReadOptions
  ) => Promise<JiraIssueSearchPage>
  /** Reads the page a continuation names. Never cached: it extends a view, not a query. */
  loadMoreJiraIssues: (
    continuation: JiraIssueSearchContinuation,
    limit?: number,
    options?: JiraSearchOptions
  ) => Promise<JiraIssueSearchPage>
  patchJiraIssue: (issueKey: string, patch: Partial<JiraIssue>, options?: JiraPatchOptions) => void
}

type JiraStateCreator = StateCreator<AppState, [], [], JiraSlice>

export type JiraSliceSet = Parameters<JiraStateCreator>[0]
export type JiraSliceGet = Parameters<JiraStateCreator>[1]
