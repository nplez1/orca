import type { Worktree } from '../../../../shared/worktree/types'

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

/** The linked issue when the pane can render it, else null. This is what the
 *  activity bar gates the Issue tab on. */
export function resolveIssuePaneLinkedIssue(
  worktree: LinkedIssueSource | null | undefined
): SupportedWorkspaceLinkedIssue | null {
  if (!worktree) {
    return null
  }
  const linked = resolveWorkspaceLinkedIssue(worktree)
  if (!linked || linked.provider === 'gitlab') {
    return null
  }
  return linked
}
