import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import { openHttpLink } from '@/lib/http-link-routing'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import type { WorkspaceAttachmentMutation } from '../../../../shared/workspace-attachment-mutation'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { translate } from '@/i18n/i18n'
import { buildWorkspaceAttachmentEdits } from '@/components/sidebar/worktree-attachment-editing'
import { buildIssueUnlinkUpdates } from '@/components/sidebar/workspace-issue-unlink-updates'
import {
  findWorkspaceIssueAttachment,
  type SupportedWorkspaceLinkedIssue
} from './workspace-linked-issue'

export type LinkedIssuePaneActions = {
  /** Opens the issue on its provider, honoring Orca's Link Routing setting and
   *  the Shift+modifier escape hatch that every other link surface honors. */
  openIssue: (url: string | null, event: React.MouseEvent<HTMLButtonElement>) => void
  unlinkIssue: () => void
  linkAnotherIssue: () => void
  /** Set when this workspace cannot store a link edit at all, so the menu can
   *  say why instead of offering an action that silently does nothing. */
  linkActionsDisabledReason: string | null
}

/** The issue an action taken from the pane is about. */
export type LinkedIssuePaneTarget = Pick<SupportedWorkspaceLinkedIssue, 'provider' | 'identifier'>

/** Link actions for the issue pane, owned by the active workspace's own link
 *  slots rather than by the pane body. */
export function useLinkedIssuePaneActions(target?: LinkedIssuePaneTarget): LinkedIssuePaneActions {
  const worktree = useActiveWorktree()
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const openModal = useAppStore((s) => s.openModal)
  const isMac = navigator.userAgent.includes('Mac')
  const worktreeId = worktree?.id
  // Why: a folder workspace stores its issue only through the creation-time
  // linkedTask, and link keys are dropped from an update for one — so neither
  // action can take effect there.
  const isFolderWorkspace = worktreeId ? parseWorkspaceKey(worktreeId)?.type === 'folder' : false
  const linkActionsDisabledReason = isFolderWorkspace
    ? translate(
        'auto.components.right.sidebar.IssuePane.folderWorkspaceLink',
        'A folder workspace keeps the issue it was created from.'
      )
    : null

  const openIssue = useCallback(
    (url: string | null, event: React.MouseEvent<HTMLButtonElement>): void => {
      if (!url) {
        return
      }
      openHttpLink(url, {
        worktreeId,
        allowRemoteInApp: true,
        // Why: Shift+modifier is the documented inverse of Link Routing, matching
        // terminal, markdown, and checks-panel links.
        modifierHeld: event.shiftKey && (isMac ? event.metaKey : event.ctrlKey)
      })
    },
    [isMac, worktreeId]
  )

  const unlinkIssue = useCallback((): void => {
    if (!worktree || linkActionsDisabledReason) {
      return
    }
    // Why the shown issue's attachment rather than `buildIssueUnlinkUpdates`: that rule clears one
    // slot per provider, which was right when a workspace held one issue and is wrong now that it
    // holds several — it would unlink an issue the user is not looking at. Removing the one
    // attachment leaves the host's selection rule to re-point the slots at what remains.
    const items = getWorkspaceAttachments(worktree)
    const attached = target ? findWorkspaceIssueAttachment(worktree, target) : null
    const updates: Partial<WorktreeMeta> & WorkspaceAttachmentMutation = attached
      ? buildWorkspaceAttachmentEdits({
          initial: items,
          draft: items.filter(
            (item) => getWorkspaceAttachmentKey(item) !== getWorkspaceAttachmentKey(attached)
          )
        })
      : buildIssueUnlinkUpdates(worktree)
    void updateWorktreeMeta(worktree.id, updates, {
      executionHostId: worktree.hostId
    }).then((result) => {
      if (!result.ok) {
        toast.error(result.error)
      }
    })
  }, [linkActionsDisabledReason, target, updateWorktreeMeta, worktree])

  const linkAnotherIssue = useCallback((): void => {
    if (!worktree || linkActionsDisabledReason) {
      return
    }
    // Why the dialog rather than an inline field: a Jira link needs a site lookup
    // that resolves the issue's title and URL, and that editor already owns it.
    // Why the workspace repo and not the created-from item's repo: the editor writes a bare
    // number into `linkedIssue`, which displaces the item, and the pane then reads that number
    // in the workspace repo — where this picker listed it. Scoping the picker anywhere else
    // would offer numbers from a repo the link no longer names.
    openModal('edit-meta', {
      worktreeId: worktree.id,
      // Why: the same workspace ID can exist under two hosts, so pin the dialog
      // to its owner instead of the ambiguous lookup.
      repoId: worktree.repoId,
      executionHostId: worktree.hostId,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentComment: worktree.comment,
      focus: 'issue'
    })
  }, [linkActionsDisabledReason, openModal, worktree])

  return { openIssue, unlinkIssue, linkAnotherIssue, linkActionsDisabledReason }
}
