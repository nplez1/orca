import { useActiveWorktree } from '@/store/selectors'
import { GithubLinkedIssuePane } from './GithubLinkedIssuePane'
import { IssuePaneMessage } from './IssuePaneMessage'
import { JiraLinkedIssuePane } from './JiraLinkedIssuePane'
import { LinearLinkedIssuePane } from './LinearLinkedIssuePane'
import { resolveIssuePaneLinkedIssue } from './workspace-linked-issue'

/** Right-sidebar pane showing the issue the active workspace is linked to.
 *
 *  The activity bar only offers the tab while the active workspace has a
 *  supported linked issue, but a persisted route can still name it across a
 *  workspace switch, so the no-link state renders here too. */
export default function IssuePane(): React.JSX.Element {
  const worktree = useActiveWorktree()
  const linkedIssue = resolveIssuePaneLinkedIssue(worktree)

  if (!worktree || !linkedIssue) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <IssuePaneMessage kind="none" />
      </div>
    )
  }

  const sourceContext = worktree.linkedTaskSourceContext ?? null
  // Why: key by workspace + issue so switching workspaces (or re-linking)
  // remounts the provider body instead of carrying the previous issue's
  // fetched state into the new one — the panel itself stays mounted.
  const paneKey = `${worktree.id}:${linkedIssue.provider}:${linkedIssue.identifier}`

  switch (linkedIssue.provider) {
    case 'github':
      return (
        <GithubLinkedIssuePane
          key={paneKey}
          worktree={worktree}
          linkedIssue={linkedIssue}
          sourceContext={sourceContext}
        />
      )
    case 'linear':
      return (
        <LinearLinkedIssuePane
          key={paneKey}
          linkedIssue={linkedIssue}
          sourceContext={sourceContext}
        />
      )
    case 'jira':
      return (
        <JiraLinkedIssuePane
          key={paneKey}
          linkedIssue={linkedIssue}
          sourceContext={sourceContext}
        />
      )
  }
}
