import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import { openHttpLink } from '@/lib/http-link-routing'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { translate } from '@/i18n/i18n'
import { buildIssueUnlinkUpdates } from '@/components/sidebar/worktree-meta-updates'
import { toWorktreeMetaLiveLinks } from '@/components/sidebar/use-worktree-meta-workspace'

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

/** Link actions for the issue pane, owned by the active workspace's own link
 *  slots rather than by the pane body.
 *
 *  Every provider goes through `buildIssueUnlinkUpdates`, which is the same
 *  clearing rule the workspace dialog's Issue field uses: a workspace holds one
 *  issue at a time, so unlinking empties the GitHub number slot, the Linear key,
 *  and the created-from work item together rather than only the slot the pane
 *  happens to be rendering. */
export function useLinkedIssuePaneActions(): LinkedIssuePaneActions {
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
    void updateWorktreeMeta(
      worktree.id,
      buildIssueUnlinkUpdates(toWorktreeMetaLiveLinks(worktree)),
      { executionHostId: worktree.hostId }
    ).then((result) => {
      if (!result.ok) {
        toast.error(result.error)
      }
    })
  }, [linkActionsDisabledReason, updateWorktreeMeta, worktree])

  const linkAnotherIssue = useCallback((): void => {
    if (!worktree || linkActionsDisabledReason) {
      return
    }
    // Why the dialog rather than an inline field: a Jira link needs a site lookup
    // that resolves the issue's title and URL, and that editor already owns it.
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
