import type { JiraSprint } from '../../shared/jira-types'
import { asIdentifier, asRecord, asString } from './jira-record-pages'

// The Agile API, served at the same path by Jira Cloud and Server/Data Center.
// Only issue *paging* moved to the newer Cloud path (see `listBoardIssues`).
export const JIRA_AGILE_API = '/rest/agile/1.0'
export const JIRA_CLOUD_SOFTWARE_API = '/rest/software/1.0'

/** Maps one Agile `SprintBean`. */
export function mapJiraSprint(value: unknown): JiraSprint | null {
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
    endDate: asString(sprint.endDate) || undefined,
    boardId: asIdentifier(sprint.originBoardId) || undefined
  }
}

/** The issue's sprint field. Jira documents a single object for the Agile issue read
 *  and site versions have been seen returning the array the platform field uses, so
 *  both parse; the issue's current sprint is the last entry either way. */
export function mapJiraSprintField(value: unknown): JiraSprint | null {
  const candidates = Array.isArray(value) ? value : value ? [value] : []
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const sprint = mapJiraSprint(candidates[index])
    if (sprint) {
      return sprint
    }
  }
  return null
}
