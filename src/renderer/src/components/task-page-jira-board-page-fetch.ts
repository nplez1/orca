import type { JiraBoardIssuePage } from '../../../shared/jira-types'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { jiraListBoardIssues } from '@/runtime/runtime-jira-client'
import type { TaskPageJiraBoardCachedPage } from './task-page-jira-board-cache'

export const JIRA_BOARD_ISSUE_PAGE_SIZE = 100
// Why: a board the user paged deeply must not turn one return-to-view into an
// unbounded burst of Jira calls, so silent revalidation stops after a few pages.
const JIRA_BOARD_REVALIDATE_MAX_PAGES = 3

export type JiraBoardIssueScope = { scope: 'sprint'; sprintId: string } | { scope: 'backlog' }

export function describeJiraBoardPageError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load this Jira board.'
}

export function emptyJiraBoardPage(): TaskPageJiraBoardCachedPage {
  return { issues: [], startAt: 0, pageToken: null, isLast: true, total: null }
}

export function appendJiraBoardIssuePage(
  current: TaskPageJiraBoardCachedPage,
  next: JiraBoardIssuePage
): TaskPageJiraBoardCachedPage {
  return {
    issues: [...current.issues, ...next.issues],
    startAt: next.startAt + next.issues.length,
    pageToken: next.nextPageToken,
    isLast: next.isLast,
    total: next.total ?? current.total
  }
}

/** Reads page 1 up to the previously-loaded depth so a silent refresh replaces the whole snapshot. */
export async function readJiraBoardScopePages(args: {
  providerSettings: RuntimeJiraSettings
  boardId: string
  siteId: string
  issueScope: JiraBoardIssueScope
  targetStartAt: number
}): Promise<TaskPageJiraBoardCachedPage> {
  const targetPages = Math.min(
    Math.max(1, Math.ceil(args.targetStartAt / JIRA_BOARD_ISSUE_PAGE_SIZE)),
    JIRA_BOARD_REVALIDATE_MAX_PAGES
  )
  let page = emptyJiraBoardPage()
  for (let index = 0; index < targetPages; index += 1) {
    const pageArgs = {
      ...(page.pageToken ? { pageToken: page.pageToken } : {}),
      startAt: page.startAt,
      maxResults: JIRA_BOARD_ISSUE_PAGE_SIZE
    }
    const request =
      args.issueScope.scope === 'sprint'
        ? {
            boardId: args.boardId,
            siteId: args.siteId,
            scope: 'sprint' as const,
            sprintId: args.issueScope.sprintId,
            ...pageArgs
          }
        : { boardId: args.boardId, siteId: args.siteId, scope: 'backlog' as const, ...pageArgs }
    page = appendJiraBoardIssuePage(page, await jiraListBoardIssues(args.providerSettings, request))
    if (page.isLast) {
      break
    }
  }
  return page
}
