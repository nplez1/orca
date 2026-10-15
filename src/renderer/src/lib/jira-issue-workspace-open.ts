import { toast } from 'sonner'

import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { findJiraIssueWorkspaceAttachmentForIssue } from '@/lib/jira-issue-workspace-attachment'
import type { JiraIssue } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

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
    [...state.allWorktrees(), ...state.folderWorkspaces.map(folderWorkspaceToWorktree)],
    issue,
    source
  )
  if (!attached) {
    startWorkspace()
    return 'started'
  }

  const workspaceScope = parseWorkspaceKey(attached.id)
  const activation =
    workspaceScope?.type === 'folder'
      ? activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId, {
          navigationIntent: 'user-open',
          ...(attached.hostId ? { executionHostId: attached.hostId } : {})
        })
      : activateAndRevealWorktree(attached.id, {
          navigationIntent: 'user-open',
          ...(attached.hostId ? { executionHostId: attached.hostId } : {})
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
