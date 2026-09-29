import type {
  JiraBoard,
  JiraBoardIssuePage,
  JiraBoardIssuePageRequest,
  JiraBoardOverview,
  JiraSiteSelection
} from '../../../shared/jira-types'
import { callRuntimeRpc } from './runtime-rpc-client'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from './runtime-jira-target'

export async function jiraListBoards(
  settings: RuntimeJiraSettings,
  siteId?: JiraSiteSelection | null,
  name?: string
): Promise<JiraBoard[]> {
  const target = getJiraRuntimeTarget(settings)
  const trimmedName = name?.trim()
  const args =
    siteId || trimmedName
      ? { ...(siteId ? { siteId } : {}), ...(trimmedName ? { name: trimmedName } : {}) }
      : undefined
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraBoard[]>(target, 'jira.listBoards', args, { timeoutMs: 30_000 })
    : window.api.jira.listBoards(args)
}

export async function jiraGetBoardOverview(
  settings: RuntimeJiraSettings,
  boardId: string,
  siteId: string
): Promise<JiraBoardOverview> {
  const target = getJiraRuntimeTarget(settings)
  const args = { boardId, siteId }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraBoardOverview>(target, 'jira.getBoardOverview', args, {
        timeoutMs: 30_000
      })
    : window.api.jira.getBoardOverview(args)
}

export async function jiraListBoardIssues(
  settings: RuntimeJiraSettings,
  request: JiraBoardIssuePageRequest
): Promise<JiraBoardIssuePage> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraBoardIssuePage>(target, 'jira.listBoardIssues', request, {
        timeoutMs: 30_000
      })
    : window.api.jira.listBoardIssues(request)
}
