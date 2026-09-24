import type {
  JiraBoardColumn,
  JiraConnectionStatus,
  JiraIssue,
  JiraTransition
} from '../../../shared/jira-types'

export type TaskPageJiraBoardFilter = 'me' | 'team' | 'all'

export function shouldShowJiraSiteSelector(
  jiraConnected: boolean,
  hasDefaultBoard: boolean,
  boardViewMode: 'board' | 'list',
  siteCount: number
): boolean {
  return jiraConnected && siteCount > 1 && (!hasDefaultBoard || boardViewMode === 'list')
}

export type TaskPageJiraBoardColumn = {
  column: JiraBoardColumn
  issues: JiraIssue[]
}

export function getTaskPageJiraBoardViewerAccountId(
  status: JiraConnectionStatus,
  siteId: string
): string | null {
  const siteAccountId = status.sites?.find((site) => site.id === siteId)?.accountId.trim()
  if (siteAccountId) {
    return siteAccountId
  }
  return status.activeSiteId === siteId ? (status.viewer?.accountId ?? null) : null
}

export function filterTaskPageJiraBoardIssues(
  issues: readonly JiraIssue[],
  filter: TaskPageJiraBoardFilter,
  viewerAccountId: string | null,
  teamValue: string
): JiraIssue[] {
  if (filter === 'all') {
    return [...issues]
  }
  if (filter === 'me') {
    return viewerAccountId
      ? issues.filter((issue) => issue.assignee?.accountId === viewerAccountId)
      : []
  }
  return teamValue ? issues.filter((issue) => issue.teamValue?.key === teamValue) : []
}

export function groupTaskPageJiraBoardIssues(
  columns: readonly JiraBoardColumn[],
  issues: readonly JiraIssue[]
): { columns: TaskPageJiraBoardColumn[]; otherIssues: JiraIssue[] } {
  const placedIssueKeys = new Set<string>()
  const groupedColumns = columns.map((column) => {
    const columnIssues: JiraIssue[] = []
    for (const issue of issues) {
      const issueKey = `${issue.siteId ?? ''}:${issue.key}`
      if (!placedIssueKeys.has(issueKey) && column.statusIds.includes(issue.status.id)) {
        placedIssueKeys.add(issueKey)
        columnIssues.push(issue)
      }
    }
    return { column, issues: columnIssues }
  })
  return {
    columns: groupedColumns,
    otherIssues: issues.filter(
      (issue) => !placedIssueKeys.has(`${issue.siteId ?? ''}:${issue.key}`)
    )
  }
}

export function getTaskPageJiraBoardTransitionTargets(
  transitions: readonly JiraTransition[],
  statusIds: readonly string[]
): JiraTransition[] {
  const targets = new Set(statusIds)
  return transitions.filter((transition) => targets.has(transition.to.id))
}
