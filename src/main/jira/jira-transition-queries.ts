import { requireStrictJiraSite } from './jira-read-failure'
import type { JiraProjectStatusOrder, JiraTransition } from '../../shared/jira-types'
import { acquire, release } from './request-queue'
import { apiBasePath, JiraApiError, jiraRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { describeFieldDraft } from './jira-field-drafts'
import { mapCreateField, mapStatus } from './jira-issue-mapping'
import {
  asFiniteNumber,
  asIdentifier,
  asRecord,
  asString,
  type JiraPagedResponse,
  type JiraRecord
} from './jira-record-pages'

/**
 * Attaches the value the issue already holds to each required transition field.
 * Jira's `required` is the transition screen's own flag, not a statement that the
 * issue is missing the field, so the values are what tell a field the user owes
 * from one that is already filled. Best effort: a failed read leaves every field
 * asked for, which is the behaviour without it.
 */
async function attachCurrentValues(
  entry: ReturnType<typeof getClients>[number],
  key: string,
  transitions: JiraTransition[]
): Promise<void> {
  const keys = new Set<string>()
  for (const transition of transitions) {
    for (const field of transition.fields ?? []) {
      // Why not the comment: it is not an issue field, so it has no value to read.
      if (field.required && field.key !== 'comment') {
        keys.add(field.key)
      }
    }
  }
  if (keys.size === 0) {
    return
  }
  const requested = [...keys].map((fieldKey) => encodeURIComponent(fieldKey)).join(',')
  try {
    const response = await jiraRequest<JiraRecord>(
      entry,
      `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}?fields=${requested}`
    )
    const values = asRecord(asRecord(response).fields)
    for (const transition of transitions) {
      for (const field of transition.fields ?? []) {
        const draft = describeFieldDraft(field, values[field.key])
        if (!draft.value.trim()) {
          continue
        }
        field.currentValue = draft.value
        if (draft.displayName?.trim()) {
          field.currentDisplayValue = draft.displayName
        }
      }
    }
  } catch (error) {
    // Why rethrow auth: a dead token must not read as "these fields are empty".
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] transition field values failed:', error)
  }
}

export async function listTransitions(
  key: string,
  siteId?: string | null,
  strict = false
): Promise<JiraTransition[]> {
  const entries = getClients(siteId)
  requireStrictJiraSite(entries, siteId, strict)
  const entry = entries[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const issuePath = `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}/transitions`
    let response: { transitions?: JiraRecord[] }
    try {
      response = await jiraRequest(entry, `${issuePath}?expand=transitions.fields`)
    } catch (error) {
      if (!(error instanceof JiraApiError) || ![400, 403, 404].includes(error.status ?? 0)) {
        throw error
      }
      response = await jiraRequest(entry, issuePath)
    }
    const transitions = (response.transitions ?? []).map((transition) => ({
      id: asString(transition.id),
      name: asString(transition.name),
      to: mapStatus(transition.to),
      fields: transition.fields
        ? Object.entries(asRecord(transition.fields))
            .map(([fieldKey, field]) => mapCreateField(field, fieldKey))
            .filter((field) => field !== null)
        : undefined
    }))
    await attachCurrentValues(entry, key, transitions)
    return transitions
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listTransitions failed:', error)
    if (strict) {
      throw error
    }
    return []
  } finally {
    release()
  }
}

export async function getProjectStatusOrder(
  projectKey: string,
  siteId?: string | null
): Promise<JiraProjectStatusOrder> {
  // Why: an omitted site can resolve to the persisted "all" selection; board
  // metadata is only truthful when exactly one Jira connection owns the project.
  const entries = getClients(siteId)
  const entry = entries.length === 1 ? entries[0] : undefined
  if (!entry) {
    return { statusIdsByColumn: [] }
  }
  await acquire()
  try {
    // Why: without an explicit board picker there is no truthful way to choose
    // among multiple project boards, so ambiguous projects keep alphabetical order.
    const params = new URLSearchParams({ projectKeyOrId: projectKey, maxResults: '2' })
    const boardsResponse = await jiraRequest<JiraPagedResponse<JiraRecord>>(
      entry,
      `/rest/agile/1.0/board?${params.toString()}`
    )
    const boards = boardsResponse.values ?? []
    const boardCount = asFiniteNumber(boardsResponse.total)
    const singleBoardIsProven =
      boards.length === 1 &&
      boardsResponse.isLast !== false &&
      (boardCount === 1 || (boardCount === null && boardsResponse.isLast === true))
    const boardId = singleBoardIsProven ? asIdentifier(asRecord(boards[0]).id) : ''
    if (!boardId) {
      return { statusIdsByColumn: [] }
    }

    const configResponse = await jiraRequest<unknown>(
      entry,
      `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/configuration`
    )
    const columns = asRecord(asRecord(configResponse).columnConfig).columns
    if (!Array.isArray(columns)) {
      return { statusIdsByColumn: [] }
    }

    // Why: issues already carry status names and IDs, so returning board IDs
    // avoids a second metadata request and keeps duplicate names unambiguous.
    const seenStatusIds = new Set<string>()
    const statusIdsByColumn: string[][] = []
    const boardColumns: NonNullable<JiraProjectStatusOrder['columns']> = []
    for (const column of columns) {
      const statuses = asRecord(column).statuses
      if (!Array.isArray(statuses)) {
        continue
      }
      const columnStatusIds: string[] = []
      for (const status of statuses) {
        const statusId = asIdentifier(asRecord(status).id)
        if (statusId && !seenStatusIds.has(statusId)) {
          seenStatusIds.add(statusId)
          columnStatusIds.push(statusId)
        }
      }
      if (columnStatusIds.length > 0) {
        statusIdsByColumn.push(columnStatusIds)
      }
      const name = asString(asRecord(column).name).trim()
      if (name) {
        boardColumns.push({ name, statusIds: columnStatusIds })
      }
    }
    return { statusIdsByColumn, ...(boardColumns.length ? { columns: boardColumns } : {}) }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] getProjectStatusOrder failed:', error)
    return { statusIdsByColumn: [] }
  } finally {
    release()
  }
}
