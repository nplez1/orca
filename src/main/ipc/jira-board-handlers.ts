import { ipcMain } from 'electron'
import type { JiraBoardIssuePageRequest, JiraSiteSelection } from '../../shared/jira-types'
import { getBoardOverview, listBoardIssues, listBoards, listCustomFields } from '../jira/issues'

function normalizeBoardSiteSelection(value: unknown): JiraSiteSelection | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const siteId = value.trim()
  return siteId ? siteId : undefined
}

/** Registers the Jira board and custom-field IPC handlers. */
export function registerJiraBoardHandlers(): void {
  ipcMain.handle('jira:listBoards', async (_event, args?: { siteId?: JiraSiteSelection }) => {
    return listBoards(normalizeBoardSiteSelection(args?.siteId))
  })

  ipcMain.handle('jira:listCustomFields', async (_event, args?: { siteId?: JiraSiteSelection }) => {
    return listCustomFields(normalizeBoardSiteSelection(args?.siteId))
  })

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
      siteId: args.siteId.trim(),
      ...(typeof args.teamFieldId === 'string' ? { teamFieldId: args.teamFieldId.trim() } : {})
    })
  })
}
