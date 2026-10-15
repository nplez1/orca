import type { JiraIssue, JiraProjectStatusOrder } from '../../../shared/jira-types'

export type TaskPageJiraIssueSection = {
  key: string
  label: string
  issues: JiraIssue[]
}

/** Board column index per status, so grouped sections follow the board's own order. */
function statusColumnRanks(order: JiraProjectStatusOrder | null): Map<string, number> {
  const ranks = new Map<string, number>()
  for (const [columnIndex, statusIds] of (order?.statusIdsByColumn ?? []).entries()) {
    for (const statusId of statusIds) {
      if (!ranks.has(statusId)) {
        ranks.set(statusId, columnIndex)
      }
    }
  }
  return ranks
}

function sectionColumnRank(
  section: TaskPageJiraIssueSection,
  ranks: ReadonlyMap<string, number>
): number {
  let rank = Number.POSITIVE_INFINITY
  for (const issue of section.issues) {
    rank = Math.min(rank, ranks.get(issue.status.id) ?? Number.POSITIVE_INFINITY)
  }
  return rank
}

/** Groups issues into one section per status, ordered by board column then name. */
export function groupJiraIssuesByStatus(
  issues: readonly JiraIssue[],
  statusOrder: JiraProjectStatusOrder | null,
  statusDirection: 'asc' | 'desc' = 'asc'
): TaskPageJiraIssueSection[] {
  const sections = new Map<string, TaskPageJiraIssueSection>()
  for (const issue of issues) {
    const key = `status:${issue.status.name}`
    const section = sections.get(key)
    if (section) {
      section.issues.push(issue)
    } else {
      sections.set(key, { key, label: issue.status.name, issues: [issue] })
    }
  }

  const ranks = statusColumnRanks(statusOrder)
  const sectionRanks = new Map(
    [...sections.values()].map((section) => [section.key, sectionColumnRank(section, ranks)])
  )
  const sortedSections = [...sections.values()].sort((a, b) => {
    const rankA = sectionRanks.get(a.key) ?? Number.POSITIVE_INFINITY
    const rankB = sectionRanks.get(b.key) ?? Number.POSITIVE_INFINITY
    return rankA === rankB ? a.label.localeCompare(b.label) : rankA - rankB
  })
  return statusDirection === 'desc' ? sortedSections.toReversed() : sortedSections
}
