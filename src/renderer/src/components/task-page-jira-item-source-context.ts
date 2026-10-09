import type { JiraIssue, JiraSite } from '../../../shared/jira-types'
import { parseJiraIssueUrl } from '../../../shared/jira-issue-url'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'

/** The project a key belongs to, as the issue-key identity check derives it. */
function projectKeyFromIssueKey(issueKey: string): string {
  return issueKey.slice(0, issueKey.lastIndexOf('-'))
}

export function bindTaskPageJiraItemSourceContext(args: {
  issue: JiraIssue
  sites: readonly JiraSite[]
  sourceContext: TaskSourceContext | null
}): TaskSourceContext | null {
  if (args.sourceContext?.provider !== 'jira' || !args.issue.siteId) {
    return null
  }
  const site = args.sites.find((candidate) => candidate.id === args.issue.siteId)
  if (!site) {
    return null
  }
  // Why the issue key's prefix and not `issue.project.key`: the item this context
  // gets paired with is identified by its key, and
  // `isWorkspaceLinkedItemSourceContextMatch` compares the two. A `project` field
  // that disagrees — or arrives empty because the account cannot see it — pairs with
  // nothing, and the composer answers a non-pairing context by dropping the item
  // silently. The workspace dialog derives the same value the same way.
  const parsed = parseJiraIssueUrl(args.issue.url)
  const projectKey = parsed ? projectKeyFromIssueKey(parsed.issueKey) : ''
  if (
    !projectKey ||
    // Same requirement as the check itself, hoisted to where it can be loud.
    parsed?.issueKey !== args.issue.key.trim().toUpperCase()
  ) {
    // Why refuse rather than build: a context that cannot pair leaves the user with
    // an unlinked workspace and no explanation. Returning null makes the composer's
    // own "couldn't link this Jira issue" toast fire instead.
    return null
  }
  return normalizeTaskSourceContext({
    ...args.sourceContext,
    providerIdentity: {
      provider: 'jira',
      siteId: site.id,
      siteUrl: site.siteUrl,
      projectKey
    },
    accountLabel: site.email || site.displayName || site.siteUrl
  })
}
