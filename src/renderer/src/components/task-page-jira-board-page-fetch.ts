import type { MutableRefObject } from 'react'
import type { JiraBoardIssuePage } from '../../../shared/jira/jira-types'
import type { RuntimeJiraSettings } from '../runtime/jira/runtime-jira-client'
import { hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import { jiraListBoardIssues } from '../runtime/jira/runtime-jira-client'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import type { TaskPageJiraBoardCachedPage } from './task-page-jira-board-cache'

export const JIRA_BOARD_ISSUE_PAGE_SIZE = 100
// Why: a board the user paged deeply must not turn one return-to-view into an
// unbounded burst of Jira calls, so silent revalidation stops after a few pages.
const JIRA_BOARD_REVALIDATE_MAX_PAGES = 3

export type JiraBoardIssueScope = { scope: 'sprint'; sprintId: string } | { scope: 'backlog' }

export function describeJiraBoardPageError(error: unknown): string {
  return extractIpcErrorMessage(
    error,
    translate('jira.board.loadFailed', 'Unable to load this Jira board.')
  )
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

/** Reads the page after `current`, so "load more" continues the depth the scope holds. */
export async function loadMoreJiraBoardPage(args: {
  providerSettings: RuntimeJiraSettings
  boardId: string
  siteId: string
  issueScope: JiraBoardIssueScope
  /**
   * The scope's page as it stands *now* — read twice, not once.
   *
   * Why a reader and not a snapshot: an optimistic card move patches the page in place without
   * bumping the generation (it is a local-only edit, not a reload), so appending onto the snapshot
   * taken before the await writes the pre-move statuses back — the card jumps to its old column and
   * the cache keeps it there.
   */
  readBase: () => TaskPageJiraBoardCachedPage
  generation: number
  generationRef: MutableRefObject<number>
  commit: (page: TaskPageJiraBoardCachedPage) => void
  setError: (message: string | null) => void
  setLoadingMore: (loading: boolean) => void
  onRuntimeBoardUnavailable: () => void
}): Promise<void> {
  // Why guarded on every branch: a reload that started meanwhile owns the scope's state.
  const stale = (): boolean => args.generation !== args.generationRef.current
  const base = args.readBase()
  const pageArgs = {
    ...(base.pageToken ? { pageToken: base.pageToken } : {}),
    startAt: base.startAt,
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
  args.setLoadingMore(true)
  args.setError(null)
  try {
    const page = await jiraListBoardIssues(args.providerSettings, request)
    if (!stale()) {
      const latest = args.readBase()
      // Why the depth check: this answer continues the page that was at `base.startAt`. A page whose
      // depth moved on (a deeper load finished first) would be appended at the wrong offset.
      if (latest.startAt === base.startAt) {
        args.commit(appendJiraBoardIssuePage(latest, page))
      }
    }
  } catch (error) {
    if (!stale()) {
      args.setError(describeJiraBoardPageError(error))
      if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
        args.onRuntimeBoardUnavailable()
      }
    }
  } finally {
    // Why outside the staleness guard: the read that owns this flag is the one that set it,
    // and a reload starting meanwhile must not leave it set forever.
    args.setLoadingMore(false)
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
