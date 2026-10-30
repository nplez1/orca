import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'

/** The issue a workspace is linked to, normalized across providers.
 *
 *  The persisted link is split across provider-specific slots on `Worktree`
 *  (`linkedIssue` / `linkedLinearIssue` / `linkedWorkItem`), so callers that
 *  need a single `{ provider, identifier }` read it through this resolver
 *  instead of re-deriving the precedence at each site. */
export type WorkspaceLinkedIssue =
  | {
      provider: 'github'
      number: number
      identifier: string
      url: string | null
      title: string | null
    }
  | {
      provider: 'linear'
      identifier: string
      workspaceId: string | null
      organizationUrlKey: string | null
      url: string | null
      title: string | null
    }
  | { provider: 'jira'; key: string; identifier: string; url: string | null; title: string | null }
  | {
      provider: 'gitlab'
      number: number
      identifier: string
      url: string | null
      title: string | null
    }

export type WorkspaceLinkedIssueProvider = WorkspaceLinkedIssue['provider']

/** Providers the pane can render a detail body for. GitLab is a supported link
 *  target but has no issue-detail fetch path, so it gets no pane. */
export type SupportedWorkspaceLinkedIssue = Extract<
  WorkspaceLinkedIssue,
  { provider: 'github' | 'linear' | 'jira' }
>

type LinkedIssueSource = Pick<
  Worktree,
  | 'linkedIssue'
  | 'linkedLinearIssue'
  | 'linkedLinearIssueWorkspaceId'
  | 'linkedLinearIssueOrganizationUrlKey'
  | 'linkedGitLabIssue'
  | 'linkedWorkItem'
  | 'linkedItems'
>

function linkedJiraIssueIdentifier(item: NonNullable<Worktree['linkedWorkItem']>): string {
  return item.jiraIdentifier ?? String(item.number)
}

/** Reads the linked issue, or null when the workspace has none.
 *
 *  Precedence mirrors the meta editor's `currentProvider`: the GitHub and
 *  Linear slots the user edits win, then the legacy GitLab slot, then the
 *  created-from work item. A Jira link only exists on the work item, so it is
 *  displaced only by an explicit GitHub/Linear link — which is exactly what the
 *  meta editor does (it deliberately leaves a Jira work item alone, having no
 *  field to show it in). PR/MR links do not count — this pane is issue-only. */
export function resolveWorkspaceLinkedIssue(
  worktree: LinkedIssueSource
): WorkspaceLinkedIssue | null {
  const item = worktree.linkedWorkItem

  if (typeof worktree.linkedIssue === 'number') {
    return {
      provider: 'github',
      number: worktree.linkedIssue,
      identifier: `#${worktree.linkedIssue}`,
      url: item?.provider === 'github' ? item.url || null : null,
      title: item?.provider === 'github' ? item.title || null : null
    }
  }

  if (worktree.linkedLinearIssue) {
    return {
      provider: 'linear',
      identifier: worktree.linkedLinearIssue,
      workspaceId: worktree.linkedLinearIssueWorkspaceId ?? null,
      organizationUrlKey: worktree.linkedLinearIssueOrganizationUrlKey ?? null,
      url: item?.provider === 'linear' ? item.url || null : null,
      title: item?.provider === 'linear' ? item.title || null : null
    }
  }

  if (typeof worktree.linkedGitLabIssue === 'number' && item?.type !== 'issue') {
    return {
      provider: 'gitlab',
      number: worktree.linkedGitLabIssue,
      identifier: `#${worktree.linkedGitLabIssue}`,
      url: null,
      title: null
    }
  }

  if (!item || item.type !== 'issue') {
    return null
  }

  switch (item.provider) {
    case 'jira':
      return {
        provider: 'jira',
        key: linkedJiraIssueIdentifier(item),
        identifier: linkedJiraIssueIdentifier(item),
        url: item.url || null,
        title: item.title || null
      }
    case 'gitlab':
      return {
        provider: 'gitlab',
        number: item.number,
        identifier: `#${item.number}`,
        url: item.url || null,
        title: item.title || null
      }
    case 'github':
      return {
        provider: 'github',
        number: item.number,
        identifier: `#${item.number}`,
        url: item.url || null,
        title: item.title || null
      }
    case 'linear':
      return {
        provider: 'linear',
        identifier: item.linearIdentifier ?? String(item.number),
        workspaceId: null,
        organizationUrlKey: null,
        url: item.url || null,
        title: item.title || null
      }
  }
}

/** One issue the pane can show, with the account its own attachment recorded. */
export type IssuePaneIssue = {
  /** Identity within one workspace: what a selection holds and what the pane is
   *  keyed on. Attachment keys move when a title, URL or source is filled in, so
   *  selecting on one would drop the selection on the next refresh. */
  key: string
  issue: SupportedWorkspaceLinkedIssue
  sourceContext: TaskSourceContext | null
}

function issuePaneIssueKey(issue: SupportedWorkspaceLinkedIssue): string {
  // Why provider + identifier and nothing else: that is the pair `findWorkspaceIssueAttachment`
  // matches on, and a scope field one source fills and another omits would list the same issue twice.
  return `${issue.provider}:${issue.identifier.toLowerCase()}`
}

/** The pane-renderable issue an attachment describes, or null for the providers
 *  this pane has no detail body for (a GitLab issue, a cross-provider PR). */
export function linkedIssueFromAttachment(
  item: WorkspaceAttachment
): SupportedWorkspaceLinkedIssue | null {
  if (item.type !== 'issue') {
    return null
  }
  const identifier = item.identifier ?? item.linearIdentifier ?? item.jiraIdentifier
  switch (item.provider) {
    case 'github':
      return {
        provider: 'github',
        number: item.number,
        identifier: `#${item.number}`,
        url: item.url || null,
        title: item.title || null
      }
    case 'linear':
      return {
        provider: 'linear',
        identifier: identifier ?? String(item.number),
        workspaceId: item.linearWorkspaceId ?? null,
        organizationUrlKey: item.linearOrganizationUrlKey ?? null,
        url: item.url || null,
        title: item.title || null
      }
    case 'jira':
      return {
        provider: 'jira',
        key: identifier ?? String(item.number),
        identifier: identifier ?? String(item.number),
        url: item.url || null,
        title: item.title || null
      }
    // The pane has no detail body for these, so an attachment of one is not selectable here.
    case 'gitlab':
    case 'bitbucket':
    case 'azure-devops':
    case 'gitea':
      return null
  }
}

/** Every issue the pane can show for this workspace, the workspace's own active
 *  issue first.
 *
 *  A workspace keeps all of its attachments in `linkedItems` and selects one
 *  active issue per provider through the compatibility slots, so the list is the
 *  slots' issue plus the attachments — the same union the sidebar card lists.
 *  The active issue leads because it is the default view, and because the activity
 *  bar reads its provider. */
export function resolveIssuePaneIssues(
  worktree: LinkedIssueSource | null | undefined
): IssuePaneIssue[] {
  if (!worktree) {
    return []
  }
  const attached: IssuePaneIssue[] = []
  for (const item of getWorkspaceAttachments(worktree)) {
    const issue = linkedIssueFromAttachment(item)
    if (issue) {
      attached.push({
        key: issuePaneIssueKey(issue),
        issue,
        sourceContext: item.taskSourceContext ?? null
      })
    }
  }
  const active = resolveWorkspaceLinkedIssue(worktree)
  const activeIssue = active && active.provider !== 'gitlab' ? active : null
  const entries: IssuePaneIssue[] = []
  const seen = new Set<string>()
  const push = (entry: IssuePaneIssue): void => {
    if (!seen.has(entry.key)) {
      seen.add(entry.key)
      entries.push(entry)
    }
  }
  if (activeIssue) {
    const key = issuePaneIssueKey(activeIssue)
    // Why a synthesized entry: the active issue's own slot can name it before `linkedItems` carries it.
    push(
      attached.find((entry) => entry.key === key) ?? {
        key,
        issue: activeIssue,
        sourceContext: null
      }
    )
  }
  for (const entry of attached) {
    push(entry)
  }
  return entries
}

/** The attachment a shown issue came from, so an action can address that issue
 *  rather than every issue the workspace has slots for. */
export function findWorkspaceIssueAttachment(
  worktree: LinkedIssueSource | null | undefined,
  issue: Pick<SupportedWorkspaceLinkedIssue, 'provider' | 'identifier'>
): WorkspaceAttachment | null {
  if (!worktree) {
    return null
  }
  return (
    getWorkspaceAttachments(worktree).find((item) => {
      if (item.type !== 'issue' || item.provider !== issue.provider) {
        return false
      }
      const identifier = item.identifier ?? item.linearIdentifier ?? item.jiraIdentifier
      return issue.provider === 'github'
        ? `#${item.number}` === issue.identifier
        : identifier?.toLowerCase() === issue.identifier.toLowerCase()
    }) ?? null
  )
}

/** The linked issue when the pane can render it, else null. This is what the
 *  activity bar gates the Issue tab on. */
export function resolveIssuePaneLinkedIssue(
  worktree: LinkedIssueSource | null | undefined
): SupportedWorkspaceLinkedIssue | null {
  return resolveIssuePaneIssues(worktree)[0]?.issue ?? null
}
