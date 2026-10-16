import type {
  JiraBoard,
  JiraBoardColumn,
  JiraBoardIssuePage,
  JiraBoardOverview,
  JiraBoardIssuePageRequest,
  JiraSiteSelection
} from '../../shared/jira-types'
import { acquire, release } from './request-queue'
import { jiraRequest } from './authenticated-request'
import { clearToken, getClients, getSingleClient, isAuthError } from './client'
import { JIRA_AGILE_API, JIRA_CLOUD_SOFTWARE_API } from './jira-agile-api'
import { ISSUE_LIST_FIELDS, mapJiraIssue } from './jira-issue-mapping'
import { agileFieldIdList, getBoardJiraFieldSelection } from './jira-agile-fields'
import { fetchBoardSprints } from './jira-sprint-queries'
import { withJiraQueuedDeadline } from './jira-read-failure'
import {
  asFiniteNumber,
  asIdentifier,
  asRecord,
  asString,
  getPageItems,
  type JiraPagedResponse,
  type JiraRecord
} from './jira-record-pages'

const BOARD_PAGE_SIZE = 50
const BOARD_ISSUE_PAGE_SIZE = 100
/** Role-field ids are a site-wide list riding in this GET's query string. The whole request
 *  line and headers share Jira's ~8 KB limit, and URL-encoding each id adds a little, so past
 *  this budget the board asks for none of them rather than 414 on a site with hundreds of
 *  person pickers. */
const BOARD_ROLE_FIELD_BUDGET_CHARS = 4096
const roleFieldBudgetWarnedSites = new Set<string>()
// Why: a stalled settings read left these selects disabled with no way to retry.
const BOARD_SETTINGS_READ_TIMEOUT_MS = 30_000

function readBoardSettings<T>(
  description: string,
  read: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  return withJiraQueuedDeadline(description, BOARD_SETTINGS_READ_TIMEOUT_MS, read)
}

/** The site's role fields, or none when they would not fit the request. Dropping them
 *  degrades "Me" to the assignee everywhere at once, and says so once per site. */
function withinBoardRoleFieldBudget(siteId: string, roleFields: readonly string[]): string[] {
  if (roleFields.join(',').length <= BOARD_ROLE_FIELD_BUDGET_CHARS) {
    return [...roleFields]
  }
  if (!roleFieldBudgetWarnedSites.has(siteId)) {
    roleFieldBudgetWarnedSites.add(siteId)
    console.warn(
      `[jira] ${roleFields.length} role fields exceed the board's ${BOARD_ROLE_FIELD_BUDGET_CHARS}-character budget; the board will match "Me" on the assignee only.`
    )
  }
  return []
}

function mapBoard(value: unknown, siteId: string, siteName: string): JiraBoard | null {
  const board = asRecord(value)
  const id = asIdentifier(board.id)
  if (!id) {
    return null
  }
  return {
    id,
    name: asString(board.name, `Board ${id}`),
    type: asString(board.type, 'unknown'),
    siteId,
    siteName
  }
}

function mapBoardColumns(value: unknown): JiraBoardColumn[] {
  const columns = asRecord(asRecord(value).columnConfig).columns
  if (!Array.isArray(columns)) {
    return []
  }
  return columns.map((column, index) => {
    const record = asRecord(column)
    const statuses = Array.isArray(record.statuses) ? record.statuses : []
    return {
      name: asString(record.name, `Column ${index + 1}`),
      statusIds: statuses
        .map((status) => asIdentifier(asRecord(status).id))
        .filter((statusId) => statusId.length > 0)
    }
  })
}

export async function listBoards(
  siteId?: JiraSiteSelection | null,
  name?: string
): Promise<JiraBoard[]> {
  const entries = getClients(siteId)
  if (entries.length === 0) {
    return []
  }
  const query = name?.trim() ?? ''
  const boardsBySite = await Promise.all(
    entries.map((entry) =>
      readBoardSettings('board list', async (signal) => {
        try {
          const params = new URLSearchParams({ maxResults: String(BOARD_PAGE_SIZE) })
          if (query) {
            params.set('name', query)
          }
          // Why: a large self-hosted site can serve thousands of boards; paging all
          // of them took ~74s and still missed the board being picked. One page plus
          // the server-side name filter is what makes the settings select usable.
          const response = await jiraRequest<JiraPagedResponse<JiraRecord>>(
            entry,
            `${JIRA_AGILE_API}/board?${params.toString()}`,
            { signal }
          )
          return getPageItems(response, 'values')
            .map((board) => mapBoard(board, entry.site.id, entry.site.displayName))
            .filter((board): board is JiraBoard => board !== null)
        } catch (error) {
          if (isAuthError(error)) {
            clearToken(entry.site.id)
          }
          throw error
        }
      })
    )
  )
  return boardsBySite.flat().sort((a, b) => a.name.localeCompare(b.name))
}

export async function getBoardOverview(
  boardId: string,
  siteId: string
): Promise<JiraBoardOverview> {
  const entry = getSingleClient(siteId)
  const encodedBoardId = encodeURIComponent(boardId)
  await acquire()
  try {
    const boardRecord = await jiraRequest<unknown>(
      entry,
      `${JIRA_AGILE_API}/board/${encodedBoardId}`
    )
    const board = mapBoard(boardRecord, entry.site.id, entry.site.displayName)
    if (!board) {
      throw new Error('Jira returned an invalid board.')
    }
    const configuration = await jiraRequest<unknown>(
      entry,
      `${JIRA_AGILE_API}/board/${encodedBoardId}/configuration`
    )
    // Why: one request serves both the sprint tab (active sprints) and the sprint
    // picker (anything an issue can be moved into), so the future sprints a
    // backlog item would go to cost no extra round trip.
    const sprints = board.type === 'scrum' ? await fetchBoardSprints(entry, boardId) : []
    return {
      board,
      columns: mapBoardColumns(configuration),
      activeSprints: sprints.filter((sprint) => sprint.state === 'active'),
      sprints
    }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
    }
    throw error
  } finally {
    release()
  }
}

export async function listBoardIssues(
  request: JiraBoardIssuePageRequest
): Promise<JiraBoardIssuePage> {
  const entry = getSingleClient(request.siteId)
  const startAt = Math.max(0, Math.floor(request.startAt ?? 0))
  const maxResults = Math.min(
    Math.max(1, Math.floor(request.maxResults ?? BOARD_ISSUE_PAGE_SIZE)),
    100
  )
  // One catalog read serves both: the role-field ids, so "Me" can match any role the
  // viewer holds, and the agile planning fields, so a card can show the site's story
  // points. The board waits on it with its own patience, and a catalog that cannot be
  // read leaves the page loading on its own fields alone.
  const selection = await getBoardJiraFieldSelection(entry)
  const roleFields = withinBoardRoleFieldBudget(entry.site.id, selection.roleFields)
  const fields = [...ISSUE_LIST_FIELDS, ...agileFieldIdList(selection.agile), ...roleFields]
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    fields: fields.join(',')
  })
  const boardId = encodeURIComponent(request.boardId)
  let path: string
  if (request.scope === 'backlog') {
    if (entry.site.authType === 'server') {
      params.set('startAt', String(startAt))
    } else if (request.pageToken) {
      params.set('nextPageToken', request.pageToken)
    }
    const basePath = entry.site.authType === 'server' ? JIRA_AGILE_API : JIRA_CLOUD_SOFTWARE_API
    path = `${basePath}/board/${boardId}/backlog?${params.toString()}`
  } else {
    if (entry.site.authType === 'server') {
      params.set('startAt', String(startAt))
    } else if (request.pageToken) {
      params.set('nextPageToken', request.pageToken)
    }
    const basePath = entry.site.authType === 'server' ? JIRA_AGILE_API : JIRA_CLOUD_SOFTWARE_API
    path = `${basePath}/board/${boardId}/sprint/${encodeURIComponent(request.sprintId)}/issue?${params.toString()}`
  }

  await acquire()
  try {
    const response = await jiraRequest<{
      issues?: JiraRecord[]
      startAt?: number
      maxResults?: number
      total?: number
      isLast?: boolean
      nextPageToken?: string
    }>(entry, path)
    const issues = (response.issues ?? []).map((issue) =>
      mapJiraIssue(entry.site, issue, undefined, { ...selection.agile, roleFields })
    )
    const responseStartAt = asFiniteNumber(response.startAt) ?? startAt
    const total = asFiniteNumber(response.total)
    const nextPageToken = asString(response.nextPageToken) || null
    const isLast =
      issues.length === 0 && nextPageToken === null
        ? true
        : (response.isLast ??
          (nextPageToken !== null
            ? false
            : total === null
              ? issues.length < maxResults
              : responseStartAt + issues.length >= total))
    return {
      issues,
      startAt: responseStartAt,
      nextPageToken,
      total,
      isLast
    }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
    }
    throw error
  } finally {
    release()
  }
}
