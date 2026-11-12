import { ipcMain } from 'electron'
import { JiraIssueListFiltersParam } from '../../../shared/rpc-contract/jira-quick-filter-params'
import type {
  JiraIssueFilter,
  JiraIssueListFilters,
  JiraIssueSearchPage,
  JiraSiteSelection
} from '../../../shared/jira/jira-types'
import type { JiraCancellableRequests } from './cancellable-requests'
import {
  clampJiraIssueLimit,
  normalizeJiraSiteSelection,
  VALID_JIRA_ISSUE_FILTERS
} from './ipc-params'
import { listIssuesPage, searchIssuesPage } from '../../jira/jira-issue-search'

const EMPTY_ISSUE_PAGE: JiraIssueSearchPage = {
  issues: [],
  hasMore: false,
  total: null,
  continuation: null
}

/** A page read resumes from either generation's cursor; anything unusable reads page 1. */
function readIssuePageCursor(args?: {
  pageToken?: string
  startAt?: number
}): { pageToken: string | null; startAt: number } | undefined {
  const pageToken = typeof args?.pageToken === 'string' && args.pageToken ? args.pageToken : null
  const startAt =
    typeof args?.startAt === 'number' && Number.isFinite(args.startAt)
      ? Math.max(0, Math.floor(args.startAt))
      : 0
  return pageToken || startAt > 0 ? { pageToken, startAt } : undefined
}

/** The list's paged reads. They share `searchRequests` so the existing cancel channel also
 *  abandons a page, rather than leaving it to hold a shared Jira pool slot. */
export function registerJiraPageHandlers(deps: { searchRequests: JiraCancellableRequests }): void {
  ipcMain.handle(
    'jira:searchIssuesPage',
    async (
      _event,
      args: {
        jql: string
        limit?: number
        siteId?: JiraSiteSelection
        pageToken?: string
        startAt?: number
        requestId?: string
      }
    ) => {
      if (typeof args?.jql !== 'string') {
        return EMPTY_ISSUE_PAGE
      }
      return deps.searchRequests.run(args.requestId, (signal) =>
        searchIssuesPage(
          args.jql,
          clampJiraIssueLimit(args.limit),
          normalizeJiraSiteSelection(args.siteId),
          signal,
          false,
          readIssuePageCursor(args)
        )
      )
    }
  )

  ipcMain.handle(
    'jira:listIssuesPage',
    async (
      _event,
      args?: {
        filter?: JiraIssueFilter
        limit?: number
        siteId?: JiraSiteSelection
        filters?: JiraIssueListFilters
        pageToken?: string
        startAt?: number
      }
    ) => {
      const filter = VALID_JIRA_ISSUE_FILTERS.has(args?.filter as JiraIssueFilter)
        ? (args!.filter as JiraIssueFilter)
        : undefined
      return listIssuesPage(
        filter,
        clampJiraIssueLimit(args?.limit),
        normalizeJiraSiteSelection(args?.siteId),
        false,
        args?.filters ? JiraIssueListFiltersParam.parse(args.filters) : undefined,
        readIssuePageCursor(args)
      )
    }
  )
}
