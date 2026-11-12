import { defineMethod } from '../../../core'
import { ListIssuesPage, SearchIssuesPage } from '../../../../../../shared/rpc-contract/jira-params'

/** A page read resumes from either generation's cursor; nothing usable means page 1. */
function pageCursor(params?: {
  pageToken?: string
  startAt?: number
}): { pageToken: string | null; startAt: number } | undefined {
  const pageToken =
    typeof params?.pageToken === 'string' && params.pageToken ? params.pageToken : null
  const startAt =
    typeof params?.startAt === 'number' && Number.isFinite(params.startAt)
      ? Math.max(0, Math.floor(params.startAt))
      : 0
  return pageToken || startAt > 0 ? { pageToken, startAt } : undefined
}

/** Why separate methods rather than a cursor on the array reads: an older host strips the
 *  cursor fields it does not declare, so a "load more" sent through them would silently
 *  serve page 1 again. */
export const JIRA_PAGE_METHODS = [
  defineMethod({
    name: 'jira.searchIssuesPage',
    permission: 'workspace',
    params: SearchIssuesPage,
    handler: async (params, { runtime, signal }) =>
      runtime.jiraSearchIssuesPage(
        params.jql,
        params.limit,
        params.siteId,
        signal,
        params.strict,
        pageCursor(params)
      )
  }),
  defineMethod({
    name: 'jira.listIssuesPage',
    permission: 'workspace',
    params: ListIssuesPage,
    handler: async (params, { runtime }) =>
      runtime.jiraListIssuesPage(
        params?.filter,
        params?.limit,
        params?.siteId,
        params?.strict,
        params?.filters,
        pageCursor(params)
      )
  })
]
