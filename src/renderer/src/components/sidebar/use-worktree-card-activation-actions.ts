import React, { useCallback, useLayoutEffect, useRef } from 'react'

import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-diagnostics'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import { restoreAgentTabFocusAfterGesture } from '@/lib/agent-tab-focus-policy'
import { isEventTargetInsideCurrentTarget } from './worktree-card-dom-events'
import type { WorktreeCardProps } from './worktree-card-model'
import type { useWorktreeCardFoundation } from './use-worktree-card-foundation'
import type { useWorktreeCardLinkedDetails } from './use-worktree-card-linked-details'

type Foundation = ReturnType<typeof useWorktreeCardFoundation>
type LinkedDetails = ReturnType<typeof useWorktreeCardLinkedDetails>

export function useWorktreeCardActivationActions({
  worktree,
  repo,
  affiliateListMode,
  onSelectionGesture,
  isActive,
  activationRowKey,
  onActivate,
  onWorktreeCardClick,
  onImmediateActivate,
  isDeleting,
  isSshDisconnected,
  updateWorktreeMeta,
  setWorkspaceUnreadByUser,
  openModal
}: Pick<
  WorktreeCardProps,
  | 'worktree'
  | 'repo'
  | 'affiliateListMode'
  | 'onSelectionGesture'
  | 'isActive'
  | 'activationRowKey'
  | 'onActivate'
  | 'onWorktreeCardClick'
  | 'onImmediateActivate'
> &
  Pick<
    Foundation,
    'isSshDisconnected' | 'updateWorktreeMeta' | 'setWorkspaceUnreadByUser' | 'openModal'
  > &
  Pick<LinkedDetails, 'isDeleting'>) {
  const worktreeRef = useRef(worktree)
  useLayoutEffect(() => {
    worktreeRef.current = worktree
  }, [worktree])
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
        return
      }
      const selection = window.getSelection()
      // Why: only suppress the click for a selection inside this card; a foreign selection must not block worktree switching.
      if (selection && selection.toString().length > 0) {
        const card = event.currentTarget
        const anchor = selection.anchorNode
        const focus = selection.focusNode
        const selectionInsideCard =
          (anchor instanceof Node && card.contains(anchor)) ||
          (focus instanceof Node && card.contains(focus))
        if (selectionInsideCard) {
          return
        }
      }
      const selectionOnly = affiliateListMode
        ? false
        : (onSelectionGesture?.(event, worktreeRef.current) ?? false)
      if (selectionOnly) {
        event.preventDefault()
        event.stopPropagation()
        // Why: a multi-select gesture activates nothing, and the card owns the restore
        // for its own clicks — the sidebar root skips plain card clicks.
        restoreAgentTabFocusAfterGesture(event.detail)
        return
      }
      if (isDeleting) {
        event.preventDefault()
        event.stopPropagation()
        restoreAgentTabFocusAfterGesture(event.detail)
        return
      }
      onWorktreeCardClick?.()
      // Use shared activation so sidebar navigation participates in back/forward history.
      recordRendererCrashBreadcrumb('sidebar_worktree_activate', {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        wasActive: isActive,
        sshDisconnected: isSshDisconnected
      })
      onImmediateActivate?.(worktree.id, activationRowKey)
      const activation = activateWorktreeFromSidebar(
        worktree.id,
        worktree.hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
      )
      // Why: the pointer gesture moved focus onto the sidebar listbox, and a
      // sleeping workspace publishes its tab only after activation — the shared
      // deferral path is what hands focus to the agent tab once it exists.
      if (activation) {
        queueWorkspaceActivationTerminalFocus(worktree.id, activation)
      }
      onActivate?.()
    },
    [
      affiliateListMode,
      worktree.id,
      worktree.repoId,
      worktree.hostId,
      repo,
      isActive,
      isDeleting,
      activationRowKey,
      isSshDisconnected,
      onActivate,
      onWorktreeCardClick,
      onImmediateActivate,
      onSelectionGesture
    ]
  )

  const handleRenameTitle = useCallback(
    // Why throw: the inline editor owns the failure surface, and a rename that only reached some
    // hosts must not read as a rename that reached all of them.
    async (displayName: string): Promise<void> => {
      const result = await updateWorktreeMeta(
        worktree.id,
        { displayName },
        { executionHostId: worktree.hostId ?? 'local' }
      )
      if (!result.ok) {
        throw new Error(result.error)
      }
    },
    [updateWorktreeMeta, worktree.hostId, worktree.id]
  )

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (affiliateListMode) {
        return
      }
      if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
        return
      }
      openModal('edit-meta', {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        executionHostId: worktree.hostId,
        currentDisplayName: worktree.displayName,
        currentIssue: worktree.linkedIssue,
        currentPR: worktree.linkedPR,
        currentComment: worktree.comment
      })
    },
    [
      openModal,
      affiliateListMode,
      worktree.comment,
      worktree.displayName,
      worktree.hostId,
      worktree.id,
      worktree.linkedIssue,
      worktree.linkedPR,
      worktree.repoId
    ]
  )

  const handleToggleUnreadQuick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setWorkspaceUnreadByUser(worktree.id, !worktree.isUnread, worktree.hostId ?? 'local')
    },
    [worktree.hostId, worktree.id, worktree.isUnread, setWorkspaceUnreadByUser]
  )

  return { handleClick, handleRenameTitle, handleDoubleClick, handleToggleUnreadQuick }
}
