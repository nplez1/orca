import { translate } from '@/i18n/i18n'
import type { IssueLinkProvider } from '../../../../shared/issue-link-input'
import {
  canReplaceLinkedWorkItem,
  isIssueFieldDirty,
  keepsLiveJiraWorkItem,
  type WorktreeMetaDraft,
  type WorktreeMetaLiveLinks,
  type WorktreeMetaSnapshot
} from './worktree-meta-updates'

function formatLinkLabel(provider: IssueLinkProvider, value: string): string {
  if (provider === 'linear') {
    return translate(
      'auto.components.sidebar.worktreeIssueDisplacement.3f61c0a8d2',
      'Linear {{value}}',
      { value }
    )
  }
  if (provider === 'jira') {
    return translate(
      'auto.components.sidebar.worktreeIssueDisplacement.b7f1d0c4a9',
      'Jira {{value}}',
      { value }
    )
  }
  return translate(
    'auto.components.sidebar.worktreeIssueDisplacement.9c4b7e1f60',
    'GitHub #{{value}}',
    { value }
  )
}

/** Why a Jira link cannot be saved over the work item this workspace holds, or
 *  null when it can. Names the actual link, because "can't replace" without a
 *  subject reads as a bug rather than a rule. */
export function getLinkedWorkItemReplacementBlock(live: WorktreeMetaLiveLinks): string | null {
  if (canReplaceLinkedWorkItem(live)) {
    return null
  }
  return live.linkedWorkItemType === 'issue'
    ? translate(
        'auto.components.sidebar.worktreeIssueDisplacement.c3a9f2b1d7',
        'This workspace is linked to a GitLab issue, which this field cannot replace.'
      )
    : translate(
        'auto.components.sidebar.worktreeIssueDisplacement.6d0e8a45b2',
        'This workspace was created from a linked change request. This field only links issues.'
      )
}

/** Names the persisted links a save would drop. A workspace tracks one issue, so
 *  a changed field displaces the other provider's slot and clearing drops both.
 *  Only a dirty field displaces anything — the dialog opens focused on Comment,
 *  and an untouched row must leave every link alone. */
export function getDisplacedLinkLabels(args: {
  draft: WorktreeMetaDraft
  snapshot: WorktreeMetaSnapshot
  isFolderWorkspace: boolean
  live: WorktreeMetaLiveLinks
}): string[] | null {
  const { draft, snapshot, isFolderWorkspace, live } = args
  if (isFolderWorkspace || !isIssueFieldDirty(draft, snapshot)) {
    return null
  }

  const keeping = draft.issueInput.trim() === '' ? null : draft.issueProvider
  const displaced: string[] = []
  if (keeping !== 'linear' && live.linkedLinearIssue) {
    displaced.push(formatLinkLabel('linear', live.linkedLinearIssue))
  }
  if (keeping !== 'github' && typeof live.linkedIssue === 'number') {
    displaced.push(formatLinkLabel('github', String(live.linkedIssue)))
  }
  // Why: ranked last because it is the only link the dialog could not write
  // before, so it is the one most likely to surprise.
  if (
    live.linkedWorkItemProvider === 'jira' &&
    live.linkedWorkItemType === 'issue' &&
    live.linkedWorkItemJiraIdentifier &&
    !(keeping === 'jira' && keepsLiveJiraWorkItem(draft, live))
  ) {
    displaced.push(formatLinkLabel('jira', live.linkedWorkItemJiraIdentifier))
  }
  return displaced.length > 0 ? displaced : null
}
