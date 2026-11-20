import type {
  JiraIssueSummaryGenerationRequest,
  JiraIssueSummaryGenerationCancellation
} from '../../../../shared/jira/jira-issue-summary-generation'
import {
  generateJiraIssueSummaryRequest,
  cancelJiraIssueSummaryRequest,
  type JiraIssueSummaryGenerationHost
} from '../../../text-generation/requests/jira-issue-summary-requests'
import type {
  JiraBoardIssuePageRequest,
  JiraCommentBodyFormat,
  JiraConnectArgs,
  JiraCreateIssueArgs,
  JiraIssueFilter,
  JiraIssueListFilters,
  JiraIssueSearchContinuation,
  JiraIssueSearchPage,
  JiraIssueUpdate,
  JiraSiteSelection,
  JiraSprintAssignment
} from '../../../../shared/jira/jira-types'
import type { JiraMediaFormat } from '../../../../shared/jira/jira-attachment-image'
import { connect, disconnect, getStatus, selectSite, testConnection } from '../../../jira/client'
import { listFavouriteFilters } from '../../../jira/favourite-filters'
import { addIssueComment, createIssue, updateIssue } from '../../../jira/jira-issue-mutations'
import { getIssue, getIssueSummary } from '../../../jira/jira-issue-read'
import { getIssueComments } from '../../../jira/jira-issue-comments'
import { getProjectStatusOrder, listTransitions } from '../../../jira/jira-transition-queries'
import { getIssueSprintAssignment } from '../../../jira/jira-sprint-queries'
import {
  listAssignableUsers,
  listCreateFields,
  listIssueTypes,
  listPriorities,
  searchUsers
} from '../../../jira/jira-issue-create-metadata'
import { getBoardOverview, listBoardIssues, listBoards } from '../../../jira/jira-board-queries'
import { listEditFields } from '../../../jira/jira-issue-edit-metadata'
import {
  listIssues,
  listIssuesPage,
  searchIssues,
  searchIssuesPage
} from '../../../jira/jira-issue-search'
import { listProjects } from '../../../jira/jira-project-queries'

export class RuntimeJiraCommands {
  constructor(private readonly host: JiraIssueSummaryGenerationHost) {}

  async jiraGenerateIssueSummary(
    args: JiraIssueSummaryGenerationRequest,
    owner: string,
    signal?: AbortSignal
  ) {
    return generateJiraIssueSummaryRequest(this.host, owner, args, signal)
  }

  jiraCancelGenerateIssueSummary(
    args: JiraIssueSummaryGenerationCancellation,
    owner: string
  ): { ok: true } {
    cancelJiraIssueSummaryRequest(owner, args)
    return { ok: true }
  }

  async jiraConnect(args: JiraConnectArgs): ReturnType<typeof connect> {
    return connect(args)
  }

  async jiraDisconnect(siteId?: string): Promise<{ ok: true }> {
    await disconnect(siteId)
    return { ok: true }
  }

  async jiraSelectSite(siteId: JiraSiteSelection): ReturnType<typeof getStatus> {
    return selectSite(siteId)
  }

  async jiraStatus(): ReturnType<typeof getStatus> {
    return getStatus()
  }

  async jiraReadStatus(): ReturnType<typeof getStatus> {
    return getStatus()
  }

  async jiraTestConnection(siteId?: string): ReturnType<typeof testConnection> {
    return testConnection(siteId)
  }

  async jiraSearchIssues(
    jql: string,
    limit = 30,
    siteId?: JiraSiteSelection,
    signal?: AbortSignal,
    strict = false
  ): ReturnType<typeof searchIssues> {
    return searchIssues(jql, Math.min(Math.max(1, limit), 100), siteId, signal, strict)
  }

  async jiraSearchIssuesPage(
    jql: string,
    limit = 30,
    siteId?: JiraSiteSelection,
    signal?: AbortSignal,
    strict = false,
    cursor?: Pick<JiraIssueSearchContinuation, 'pageToken' | 'startAt'>
  ): Promise<JiraIssueSearchPage> {
    return searchIssuesPage(jql, Math.min(Math.max(1, limit), 100), siteId, signal, strict, cursor)
  }

  async jiraListIssues(
    filter?: JiraIssueFilter,
    limit = 30,
    siteId?: JiraSiteSelection,
    strict = false,
    filters?: JiraIssueListFilters
  ): ReturnType<typeof listIssues> {
    return listIssues(filter, Math.min(Math.max(1, limit), 100), siteId, strict, filters)
  }

  async jiraListIssuesPage(
    filter?: JiraIssueFilter,
    limit = 30,
    siteId?: JiraSiteSelection,
    strict = false,
    filters?: JiraIssueListFilters,
    cursor?: Pick<JiraIssueSearchContinuation, 'pageToken' | 'startAt'>
  ): Promise<JiraIssueSearchPage> {
    return listIssuesPage(
      filter,
      Math.min(Math.max(1, limit), 100),
      siteId,
      strict,
      filters,
      cursor
    )
  }

  async jiraCreateIssue(args: JiraCreateIssueArgs): ReturnType<typeof createIssue> {
    return createIssue(args)
  }

  async jiraGetIssue(
    key: string,
    siteId?: string,
    strict = false,
    mediaFormat?: JiraMediaFormat
  ): ReturnType<typeof getIssue> {
    return getIssue(key, siteId, strict, mediaFormat)
  }

  async jiraLookupIssueSummary(
    key: string,
    siteId: string,
    signal?: AbortSignal
  ): ReturnType<typeof getIssueSummary> {
    return getIssueSummary(key, siteId, signal)
  }

  /** Fields this user can edit on an existing issue, with the current values. */
  async jiraListEditFields(
    key: string,
    siteId?: string,
    strict = false
  ): ReturnType<typeof listEditFields> {
    return listEditFields(key, siteId, strict)
  }

  async jiraUpdateIssue(
    key: string,
    updates: JiraIssueUpdate,
    siteId?: string
  ): ReturnType<typeof updateIssue> {
    return updateIssue(key, updates, siteId)
  }

  async jiraAddIssueComment(
    key: string,
    body: string,
    siteId?: string,
    bodyFormat?: JiraCommentBodyFormat
  ): ReturnType<typeof addIssueComment> {
    return addIssueComment(key, body, siteId, bodyFormat)
  }

  async jiraIssueComments(
    key: string,
    siteId?: string,
    strict = false,
    mediaFormat?: JiraMediaFormat
  ): ReturnType<typeof getIssueComments> {
    return getIssueComments(key, siteId, strict, mediaFormat)
  }

  async jiraListProjects(
    siteId?: JiraSiteSelection,
    strict = false
  ): ReturnType<typeof listProjects> {
    return listProjects(siteId, strict)
  }

  async jiraListFavouriteFilters(
    siteId: string,
    signal?: AbortSignal
  ): ReturnType<typeof listFavouriteFilters> {
    return listFavouriteFilters(siteId, signal)
  }

  async jiraListIssueTypes(
    projectIdOrKey: string,
    siteId?: string,
    strict = false
  ): ReturnType<typeof listIssueTypes> {
    return listIssueTypes(projectIdOrKey, siteId, strict)
  }

  async jiraListCreateFields(
    projectIdOrKey: string,
    issueTypeId: string,
    siteId?: string,
    strict = false
  ): ReturnType<typeof listCreateFields> {
    return listCreateFields(projectIdOrKey, issueTypeId, siteId, strict)
  }

  async jiraListPriorities(siteId?: string, strict = false): ReturnType<typeof listPriorities> {
    return listPriorities(siteId, strict)
  }

  async jiraListAssignableUsers(
    key: string,
    query?: string,
    siteId?: string,
    strict = false
  ): ReturnType<typeof listAssignableUsers> {
    return listAssignableUsers(key, query, siteId, strict)
  }

  /** Searches all users on the site, for reporter and user-picker create fields. */
  async jiraSearchUsers(query?: string, siteId?: string): ReturnType<typeof searchUsers> {
    return searchUsers(query, siteId)
  }

  async jiraListTransitions(
    key: string,
    siteId?: string,
    strict = false
  ): ReturnType<typeof listTransitions> {
    return listTransitions(key, siteId, strict)
  }

  async jiraGetProjectStatusOrder(
    projectKey: string,
    siteId?: string
  ): ReturnType<typeof getProjectStatusOrder> {
    return getProjectStatusOrder(projectKey, siteId)
  }

  async jiraListBoards(siteId?: JiraSiteSelection, name?: string): ReturnType<typeof listBoards> {
    return listBoards(siteId, name)
  }

  async jiraGetBoardOverview(boardId: string, siteId: string): ReturnType<typeof getBoardOverview> {
    return getBoardOverview(boardId, siteId)
  }

  async jiraListBoardIssues(
    request: JiraBoardIssuePageRequest
  ): ReturnType<typeof listBoardIssues> {
    return listBoardIssues(request)
  }

  async jiraGetIssueSprintAssignment(request: {
    key: string
    siteId?: string | null
    boardId?: string | null
  }): Promise<JiraSprintAssignment> {
    return getIssueSprintAssignment(request)
  }
}
