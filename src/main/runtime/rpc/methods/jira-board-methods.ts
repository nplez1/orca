import { defineMethod } from '../core'
import {
  BoardIdentifier,
  BoardIssuePage,
  BoardListQuery,
  IssueSprintAssignment
} from '../../../../shared/rpc-contract/jira-params'

export const JIRA_BOARD_METHODS = [
  defineMethod({
    name: 'jira.listBoards',
    permission: 'workspace',
    params: BoardListQuery,
    handler: async (params, { runtime }) => runtime.jiraListBoards(params?.siteId, params?.name)
  }),
  defineMethod({
    name: 'jira.getBoardOverview',
    permission: 'workspace',
    params: BoardIdentifier,
    handler: async (params, { runtime }) =>
      runtime.jiraGetBoardOverview(params.boardId.trim(), params.siteId.trim())
  }),
  defineMethod({
    name: 'jira.listBoardIssues',
    permission: 'workspace',
    params: BoardIssuePage,
    handler: async (params, { runtime }) => runtime.jiraListBoardIssues(params)
  }),
  defineMethod({
    name: 'jira.getIssueSprintAssignment',
    permission: 'workspace',
    params: IssueSprintAssignment,
    handler: async (params, { runtime }) =>
      runtime.jiraGetIssueSprintAssignment({
        key: params.key.trim(),
        siteId: params.siteId,
        boardId: params.boardId
      })
  })
]
