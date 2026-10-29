import type { JiraSprint, JiraSprintAssignment } from '../../shared/jira/jira-types'
import { acquire, release } from './request-queue'
import { recordSwallowedFailure } from '../observability/swallowed-failure'
import { jiraRequest, type JiraClientForSite } from './authenticated-request'
import { clearToken, getSingleClient, isAuthError } from './client'
import { JIRA_AGILE_API, mapJiraSprint, mapJiraSprintField } from './jira-agile-api'
import { asRecord, fetchPagedRecords, type JiraRecord } from './jira-record-pages'

const SPRINT_PAGE_SIZE = 50
// Only open sprints can receive issues: Jira rejects a move to a closed sprint.
const ASSIGNABLE_SPRINT_STATES = 'active,future'

function sprintStateRank(state: string): number {
  if (state === 'active') {
    return 0
  }
  return state === 'future' ? 1 : 2
}

function compareSprints(a: JiraSprint, b: JiraSprint): number {
  const byState = sprintStateRank(a.state) - sprintStateRank(b.state)
  if (byState !== 0) {
    return byState
  }
  const byStart = (a.startDate ?? '').localeCompare(b.startDate ?? '')
  return byStart !== 0 ? byStart : a.name.localeCompare(b.name)
}

/** Assignable (active + future) sprints of one board.
 *  Split from the pooling wrapper so `getBoardOverview` can reuse it while it
 *  already holds a request-queue slot. */
export async function fetchBoardSprints(
  entry: JiraClientForSite,
  boardId: string
): Promise<JiraSprint[]> {
  const encodedBoardId = encodeURIComponent(boardId)
  const records = await fetchPagedRecords(
    entry,
    'values',
    (startAt, maxResults) => {
      const params = new URLSearchParams({
        state: ASSIGNABLE_SPRINT_STATES,
        startAt: String(startAt),
        maxResults: String(maxResults)
      })
      return `${JIRA_AGILE_API}/board/${encodedBoardId}/sprint?${params.toString()}`
    },
    SPRINT_PAGE_SIZE
  )
  return (
    records
      .map(mapJiraSprint)
      // Why the client-side filter as well: the request asks for active + future, and a
      // deployment that ignores that parameter would otherwise offer closed sprints,
      // which Jira refuses to move an issue into.
      .filter((sprint): sprint is JiraSprint => sprint !== null && sprint.state !== 'closed')
  )
}

/** Where one issue sits, plus every sprint it can be moved into.
 *
 *  `boardId` is the board the user is looking at: an issue in a board's backlog
 *  has no sprint to name its own board, so without the hint there is nothing to
 *  list. The sprints of a board the issue is not on are offered anyway — Jira
 *  answers a move it will not accept with the reason, which reaches the user. */
export async function getIssueSprintAssignment(request: {
  key: string
  siteId?: string | null
  boardId?: string | null
}): Promise<JiraSprintAssignment> {
  const entry = getSingleClient(request.siteId)
  await acquire()
  try {
    const issue = await jiraRequest<JiraRecord>(
      entry,
      `${JIRA_AGILE_API}/issue/${encodeURIComponent(request.key)}`
    )
    const sprint = mapJiraSprintField(asRecord(issue.fields).sprint)
    const boardIds = [
      ...new Set([request.boardId, sprint?.boardId].filter((id): id is string => Boolean(id)))
    ]
    const listed: JiraSprint[] = []
    for (const boardId of boardIds) {
      try {
        listed.push(...(await fetchBoardSprints(entry, boardId)))
      } catch (error) {
        // Why: a board that will not list sprints — a Kanban board, or one the user
        // can no longer see — must not hide what the remaining boards offer.
        if (isAuthError(error)) {
          throw error
        }
        recordSwallowedFailure('jira', error, 'board sprint list unavailable')
      }
    }
    // The current sprint stays pickable even when its own board was not listed.
    const byId = new Map<string, JiraSprint>()
    for (const option of [...listed, ...(sprint ? [sprint] : [])]) {
      if (!byId.has(option.id)) {
        byId.set(option.id, option)
      }
    }
    return { sprint, sprints: [...byId.values()].sort(compareSprints) }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
    }
    throw error
  } finally {
    release()
  }
}
