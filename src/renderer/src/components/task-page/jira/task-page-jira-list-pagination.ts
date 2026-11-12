import type {
  JiraIssue,
  JiraIssueSearchContinuation,
  JiraIssueSearchPage
} from '../../../../../shared/jira/jira-types'

/** What the list header and footer need to say about the page behind the rendered rows. */
export type TaskPageJiraListPage = {
  hasMore: boolean
  total: number | null
  continuation: JiraIssueSearchContinuation | null
}

export function toTaskPageJiraListPage(page: JiraIssueSearchPage): TaskPageJiraListPage {
  return { hasMore: page.hasMore, total: page.total, continuation: page.continuation }
}

/** Issue keys repeat across sites, so identity needs the site as well. */
export function jiraIssueIdentity(issue: Pick<JiraIssue, 'key' | 'siteId'>): string {
  return `${issue.siteId ?? ''}::${issue.key}`
}

/** Appends a page, dropping rows an `ORDER BY updated` window can serve twice. */
export function appendJiraIssuePage(
  current: readonly JiraIssue[],
  incoming: readonly JiraIssue[]
): JiraIssue[] {
  const seen = new Set(current.map(jiraIssueIdentity))
  return [...current, ...incoming.filter((issue) => !seen.has(jiraIssueIdentity(issue)))]
}
