import type {
  JiraBoard,
  JiraBoardIssuePage,
  JiraBoardIssuePageRequest,
  JiraBoardOverview,
  JiraSiteSelection,
  JiraSprintAssignment
} from '../../../shared/jira/jira-types'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
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

/** Where one issue sits, and the sprints it can be moved into.
 *
 *  Resolves to null on a host that predates sprint assignment: a client and its
 *  remote host update independently, and hiding the control is the only honest
 *  answer when the host cannot move the issue. */
export async function jiraGetIssueSprintAssignment(
  settings: RuntimeJiraSettings,
  key: string,
  siteId?: string | null,
  boardId?: string | null
): Promise<JiraSprintAssignment | null> {
  const target = getJiraRuntimeTarget(settings)
  const args = { key, ...(siteId ? { siteId } : {}), ...(boardId ? { boardId } : {}) }
  try {
    return target.kind === 'environment'
      ? await callRuntimeRpc<JiraSprintAssignment>(target, 'jira.getIssueSprintAssignment', args, {
          timeoutMs: 30_000
        })
      : await window.api.jira.getIssueSprintAssignment(args)
  } catch (error) {
    // Why outside the branch: the web client also talks to a server that may predate
    // the method, and a missing method there must hide the control, not show an error.
    if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      return null
    }
    throw error
  }
}
