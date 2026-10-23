import { toast } from 'sonner'

import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { findJiraIssueWorkspaceAttachmentForIssue } from '@/lib/jira-issue-workspace-attachment'
import type { JiraIssue } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { Worktree } from '../../../shared/worktree/types'

/**
 * Activates one workspace already linked to a Jira issue, qualified with its
 * execution host so a remote worktree opens on the host that owns it. Shared by
 * the open-or-start action and the linked-workspace picker so neither can drop
 * the host (upstream's picker did).
 */
export function openJiraIssueWorkspace(workspace: Worktree): 'opened' | 'failed' {
  const workspaceScope = parseWorkspaceKey(workspace.id)
  const activation =
    workspaceScope?.type === 'folder'
      ? activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId, {
          navigationIntent: 'user-open',
          ...(workspace.hostId ? { executionHostId: workspace.hostId } : {})
        })
      : activateAndRevealWorktree(workspace.id, {
          navigationIntent: 'user-open',
          ...(workspace.hostId ? { executionHostId: workspace.hostId } : {})
        })
  if (activation === false) {
    toast.error(
      translate(
        'auto.lib.jira.issue.workspace.open.failed',
        'Unable to open the workspace attached to this issue.'
      )
    )
    return 'failed'
  }
  return 'opened'
}

/**
 * Opens the workspace already attached to a Jira issue, or starts a new one.
 * Re-reads worktrees from the store so a workspace created since the last render
 * is still honoured instead of starting a duplicate.
 */
export function openJiraIssueWorkspaceOrStart(
  issue: JiraIssue,
  source: TaskSourceContext | null | undefined,
  startWorkspace: () => void
): 'opened' | 'started' | 'failed' {
  const state = useAppStore.getState()
  // Why the shared finder: the sheet's label and this action must resolve the same
  // workspace — strict identity first, then the fork's permissive URL-identity finder
  // — so the label and the click can never disagree about what they point at.
  const attached = findJiraIssueWorkspaceAttachmentForIssue(
    [...state.allWorktrees(), ...selectFolderWorkspaces(state).map(folderWorkspaceToWorktree)],
    issue,
    source
  )
  if (!attached) {
    startWorkspace()
    return 'started'
  }
  return openJiraIssueWorkspace(attached)
}
