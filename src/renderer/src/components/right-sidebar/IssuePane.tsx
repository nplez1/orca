import { useMemo, useState } from 'react'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { Worktree } from '../../../../shared/worktree/types'
import { useStableTaskSource } from '@/hooks/useStableTaskSource'
import { accountBackedDetailSource } from '@/lib/account-backed-detail-source'
import { workspaceAccountHostId } from '@/lib/workspace-account-host-id'
import { getWorkspaceAttachmentSourceContext } from '../sidebar/workspace-attachment-source-result'
import { GithubLinkedIssuePane } from './GithubLinkedIssuePane'
import { IssuePaneMessage } from './IssuePaneMessage'
import { JiraLinkedIssuePane } from './JiraLinkedIssuePane'
import { LinearLinkedIssuePane } from './LinearLinkedIssuePane'
import { resolveIssuePaneIssues } from './workspace-linked-issue'

/**
 * The account a linked issue of `provider` lives on. Why the sidebar's own resolver and not a
 * private one: the workspace card, the attachment search and this pane have to name the same
 * source, or a cache patch scoped to one of them leaves the others showing a stale issue. It
 * already prefers a creation-time task source of the same provider — a workspace created from a
 * Jira task keeps that source when a Linear issue is linked to it afterwards — and resolves the
 * account host through `workspaceAccountHostId`, so a paired server's credentials win over this
 * computer's.
 */
function linkedIssueOwnerSource(
  provider: 'jira' | 'linear',
  repo: Repo | undefined,
  worktree: Worktree | undefined
): TaskSourceContext {
  return (
    getWorkspaceAttachmentSourceContext(provider, repo, worktree) ??
    // Unreachable while a workspace is rendered; the pane only mounts with one.
    accountBackedDetailSource(provider, workspaceAccountHostId(repo, worktree))
  )
}

/** Right-sidebar pane showing the issue the active workspace is linked to.
 *
 *  The activity bar only offers the tab while the active workspace has a
 *  supported linked issue, but a persisted route can still name it across a
 *  workspace switch, so the no-link state renders here too. */
export default function IssuePane(): React.JSX.Element {
  const worktree = useActiveWorktree()
  const repo = useRepoById(worktree?.repoId ?? null)
  // Why a view selection rather than the workspace's own link: the active issue is a single
  // compatibility slot per provider, so promoting one to active across providers clears the sibling
  // link instead of reordering them. Selecting here decides what this pane reads and nothing else.
  const [selection, setSelection] = useState<{ worktreeId: string; key: string } | null>(null)
  // Why derived rather than stored: the resolved list is built fresh per store write, and a
  // selection whose issue was unlinked (or whose workspace changed) has to fall back to the
  // workspace's own active issue — which the resolver puts first.
  const issues = resolveIssuePaneIssues(worktree)
  const selectedIssue =
    (selection && worktree?.id === selection.worktreeId
      ? issues.find((entry) => entry.key === selection.key)
      : undefined) ?? issues[0]
  // Why a task source per provider rather than one bare target: the store's read scope, the cache
  // keys it writes, and every child that takes a source all key on it, so a single source keeps the
  // pane's reads and writes on one host. Why the workspace's own account and not the Active Server:
  // the linked issue belongs to this workspace, so a focused-server change must not read another
  // server's account. Why the memo: the chosen source is allocated per call, and the panes refetch
  // on its identity.
  const ownerSources = useMemo(
    () => ({
      jira: linkedIssueOwnerSource('jira', repo ?? undefined, worktree ?? undefined),
      linear: linkedIssueOwnerSource('linear', repo ?? undefined, worktree ?? undefined)
    }),
    [repo, worktree]
  )
  // Why the issue's own source first: an attached issue records the account it was attached from,
  // and the shown issue is not always the workspace's active one. The workspace's source is the
  // fallback for a link that predates attachments.
  const selectedSource = selectedIssue?.sourceContext ?? null
  // Why held by value: the row above is replaced by routine store writes (a PTY bind bumps
  // `lastActivityAt`), and the panes refetch on their source's identity.
  const jiraSource = useStableTaskSource(
    selectedIssue?.issue.provider === 'jira'
      ? (selectedSource ?? ownerSources.jira)
      : ownerSources.jira
  )
  const linearSource = useStableTaskSource(
    selectedIssue?.issue.provider === 'linear'
      ? (selectedSource ?? ownerSources.linear)
      : ownerSources.linear
  )
  // Why nullable here: a GitHub link can carry no source at all, and a fabricated one would route
  // the read at another account.
  const githubSource = useStableTaskSource(
    selectedIssue?.issue.provider === 'github'
      ? (selectedSource ?? worktree?.linkedTaskSourceContext ?? null)
      : (worktree?.linkedTaskSourceContext ?? null)
  )

  if (!worktree || !selectedIssue) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <IssuePaneMessage kind="none" />
      </div>
    )
  }

  const issue = selectedIssue.issue
  // Why: key by workspace + issue so switching workspaces, re-linking, or picking
  // another issue remounts the provider body instead of carrying the previous
  // issue's fetched state into the new one — the panel itself stays mounted.
  const paneKey = `${worktree.id}:${selectedIssue.key}`
  const issueSwitcher = {
    options: issues.map((entry) => ({
      key: entry.key,
      provider: entry.issue.provider,
      identifier: entry.issue.identifier,
      title: entry.issue.title
    })),
    selectedKey: selectedIssue.key,
    onSelectIssue: (key: string) => setSelection({ worktreeId: worktree.id, key })
  }

  switch (issue.provider) {
    case 'github':
      return (
        <GithubLinkedIssuePane
          key={paneKey}
          worktree={worktree}
          linkedIssue={issue}
          sourceContext={githubSource}
          issueSwitcher={issueSwitcher}
        />
      )
    case 'linear':
      return (
        <LinearLinkedIssuePane
          key={paneKey}
          linkedIssue={issue}
          sourceContext={linearSource}
          issueSwitcher={issueSwitcher}
        />
      )
    case 'jira':
      return (
        <JiraLinkedIssuePane
          key={paneKey}
          linkedIssue={issue}
          sourceContext={jiraSource}
          issueSwitcher={issueSwitcher}
        />
      )
  }
}
