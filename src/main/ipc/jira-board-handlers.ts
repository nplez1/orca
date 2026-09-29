import { ipcMain } from 'electron'
import type { JiraBoardIssuePageRequest, JiraSiteSelection } from '../../shared/jira-types'
import { getBoardOverview, listBoardIssues, listBoards } from '../jira/issues'

function normalizeBoardSiteSelection(value: unknown): JiraSiteSelection | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const siteId = value.trim()
  return siteId ? siteId : undefined
}

function normalizeBoardName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const name = value.trim()
  return name ? name : undefined
}

/** Registers the Jira board and custom-field IPC handlers. */
export function registerJiraBoardHandlers(): void {
  ipcMain.handle(
    'jira:listBoards',
    async (_event, args?: { siteId?: JiraSiteSelection; name?: string }) => {
      return listBoards(normalizeBoardSiteSelection(args?.siteId), normalizeBoardName(args?.name))
    }
  )

  ipcMain.handle(
    'jira:getBoardOverview',
    async (_event, args: { boardId: string; siteId: string }) => {
      if (
        typeof args?.boardId !== 'string' ||
        !args.boardId.trim() ||
        typeof args?.siteId !== 'string' ||
        !args.siteId.trim()
      ) {
        throw new Error('Board ID and Jira site are required.')
      }
      return getBoardOverview(args.boardId.trim(), args.siteId.trim())
    }
  )

  ipcMain.handle('jira:listBoardIssues', async (_event, args: JiraBoardIssuePageRequest) => {
    if (
      typeof args?.boardId !== 'string' ||
      !args.boardId.trim() ||
      typeof args?.siteId !== 'string' ||
      !args.siteId.trim() ||
      (args.scope !== 'backlog' && args.scope !== 'sprint') ||
      (args.scope === 'sprint' && (typeof args.sprintId !== 'string' || !args.sprintId.trim()))
    ) {
      return { issues: [], startAt: 0, nextPageToken: null, total: 0, isLast: true }
    }
    return listBoardIssues({
      ...args,
      boardId: args.boardId.trim(),
      siteId: args.siteId.trim()
    })
  })
}
