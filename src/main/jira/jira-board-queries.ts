import type {
  JiraBoard,
  JiraBoardColumn,
  JiraBoardIssuePage,
  JiraBoardOverview,
  JiraBoardIssuePageRequest,
  JiraField,
  JiraSiteSelection
} from '../../shared/jira-types'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { ISSUE_LIST_FIELDS, mapJiraIssue } from './jira-issue-mapping'
import {
  asFiniteNumber,
  asIdentifier,
  asRecord,
  asString,
  fetchPagedRecords,
  type JiraRecord
} from './jira-record-pages'

const JIRA_AGILE_API = '/rest/agile/1.0'
const BOARD_PAGE_SIZE = 50
const BOARD_ISSUE_PAGE_SIZE = 100

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

function mapField(value: unknown, siteId: string, siteName: string): JiraField | null {
  const field = asRecord(value)
  const id = asString(field.id)
  if (!id || field.custom !== true) {
    return null
  }
  const schema = asRecord(field.schema)
  return {
    id,
    name: asString(field.name, id),
    schemaType: asString(schema.type) || undefined,
    customType: asString(schema.custom) || undefined,
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

function mapActiveSprint(value: unknown): JiraBoardOverview['activeSprints'][number] | null {
  const sprint = asRecord(value)
  const id = asIdentifier(sprint.id)
  if (!id) {
    return null
  }
  return {
    id,
    name: asString(sprint.name, `Sprint ${id}`),
    state: asString(sprint.state, 'active'),
    startDate: asString(sprint.startDate) || undefined,
    endDate: asString(sprint.endDate) || undefined
  }
}

function getSingleClient(siteId: string) {
  const entries = getClients(siteId)
  if (entries.length !== 1) {
    throw new Error('A single Jira site is required for board data.')
  }
  return entries[0]
}

export async function listBoards(siteId?: JiraSiteSelection | null): Promise<JiraBoard[]> {
  const entries = getClients(siteId)
  if (entries.length === 0) {
    return []
  }
  const boardsBySite = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        const records = await fetchPagedRecords(
          entry,
          'values',
          (startAt, maxResults) => {
            const params = new URLSearchParams({
              startAt: String(startAt),
              maxResults: String(maxResults)
            })
            return `${JIRA_AGILE_API}/board?${params.toString()}`
          },
          BOARD_PAGE_SIZE
        )
        return records
          .map((board) => mapBoard(board, entry.site.id, entry.site.displayName))
          .filter((board): board is JiraBoard => board !== null)
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.site.id)
        }
        throw error
      } finally {
        release()
      }
    })
  )
  return boardsBySite.flat().sort((a, b) => a.name.localeCompare(b.name))
}

export async function listCustomFields(siteId?: JiraSiteSelection | null): Promise<JiraField[]> {
  const entries = getClients(siteId)
  if (entries.length === 0) {
    return []
  }
  const fieldsBySite = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        const fields = await jiraRequest<unknown>(entry, `${apiBasePath(entry.site)}/field`)
        return (Array.isArray(fields) ? fields : [])
          .map((field) => mapField(field, entry.site.id, entry.site.displayName))
          .filter((field): field is JiraField => field !== null)
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.site.id)
        }
        throw error
      } finally {
        release()
      }
    })
  )
  return fieldsBySite.flat().sort((a, b) => a.name.localeCompare(b.name))
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
    const activeSprints =
      board.type === 'scrum'
        ? (
            await fetchPagedRecords(
              entry,
              'values',
              (startAt, maxResults) => {
                const params = new URLSearchParams({
                  state: 'active',
                  startAt: String(startAt),
                  maxResults: String(maxResults)
                })
                return `${JIRA_AGILE_API}/board/${encodedBoardId}/sprint?${params.toString()}`
              },
              BOARD_PAGE_SIZE
            )
          )
            .map(mapActiveSprint)
            .filter((sprint): sprint is NonNullable<typeof sprint> => sprint !== null)
        : []
    return {
      board,
      columns: mapBoardColumns(configuration),
      activeSprints
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
  const fields = [...ISSUE_LIST_FIELDS]
  if (request.teamFieldId && !fields.includes(request.teamFieldId)) {
    fields.push(request.teamFieldId)
  }
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
    const basePath = entry.site.authType === 'server' ? JIRA_AGILE_API : '/rest/software/1.0'
    path = `${basePath}/board/${boardId}/backlog?${params.toString()}`
  } else {
    if (entry.site.authType === 'server') {
      params.set('startAt', String(startAt))
    } else if (request.pageToken) {
      params.set('nextPageToken', request.pageToken)
    }
    const basePath = entry.site.authType === 'server' ? JIRA_AGILE_API : '/rest/software/1.0'
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
      mapJiraIssue(entry.site, issue, undefined, request.teamFieldId)
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
