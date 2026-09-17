import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { useDeleteWorktreeDialogActions } from './use-delete-worktree-dialog-actions'
import { useDeleteRemoteBranchChoice } from './use-delete-remote-branch-choice'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'
import { DeleteWorktreeLineageNotice } from './DeleteWorktreeLineageNotice'
import { DeleteWorktreeSkipConfirmOption } from './DeleteWorktreeSkipConfirmOption'
import { DeleteWorktreeRemoteBranchOption } from './DeleteWorktreeRemoteBranchOption'
import { DeleteWorktreeDialogFooter } from './DeleteWorktreeDialogFooter'
import { DeleteWorktreeDialogDescription } from './DeleteWorktreeDialogDescription'
import { DeleteWorktreeTargetPreview } from './DeleteWorktreeTargetPreview'
import { DeleteWorktreeWarningPanels } from './DeleteWorktreeWarningPanels'
import { persistDeleteWorktreeConfirmSkipPreference } from './delete-worktree-preference-toast'
import { getDeleteWorktreeDirtyChangeCounts } from './delete-worktree-dirty-change-counts'
import {
  countFolderWorkspaceDeletes,
  getDeleteWorktreeDialogCopy,
  getDeleteWorktreeLineageDialogCopy,
  isFolderWorkspaceDelete as getIsFolderWorkspaceDelete
} from './delete-worktree-dialog-copy'
import { translate } from '@/i18n/i18n'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import { useDeleteWorktreeStatusHydration } from './use-delete-worktree-status-hydration'
import { useConfirmedWorktreeDeleteTargets } from './use-confirmed-worktree-delete-targets'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'
import { useSidebarHostScopeOptions } from './use-sidebar-host-scope-options'

const DeleteWorktreeDialog = React.memo(function DeleteWorktreeDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const clearWorktreeDeleteState = useAppStore((s) => s.clearWorktreeDeleteState)
  const allWorktrees = useAllWorktrees()
  const repos = useAppStore((s) => s.repos)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const settings = useAppStore((s) => s.settings)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const { hostOptions } = useSidebarHostScopeOptions()
  const hostLabelById = useMemo(
    () => new Map(hostOptions.map((host) => [host.id, host.label])),
    [hostOptions]
  )
  const isOpen = activeModal === 'delete-worktree'
  const worktreeId = typeof modalData.worktreeId === 'string' ? modalData.worktreeId : ''
  const worktreeIds = useMemo(
    () =>
      Array.isArray(modalData.worktreeIds)
        ? modalData.worktreeIds.filter((id): id is string => typeof id === 'string')
        : worktreeId
          ? [worktreeId]
          : [],
    [modalData.worktreeIds, worktreeId]
  )
  const { worktreeDeleteIdentities, lineageDeleteIdentities, resolveConfirmedTargets } =
    useConfirmedWorktreeDeleteTargets({
      worktreeIdentityData: modalData.worktreeDeleteIdentities,
      lineageIdentityData: modalData.lineageDeleteIdentities,
      closeModal
    })
  const deleteStateTargets = useMemo(
    () =>
      worktreeDeleteIdentities.length > 0
        ? worktreeDeleteIdentities
        : worktreeIds.map((id) => ({ id, hostId: undefined })),
    [worktreeDeleteIdentities, worktreeIds]
  )
  const onDeleted =
    typeof modalData.onDeleted === 'function'
      ? (modalData.onDeleted as (targets: WorktreeRemovalTarget[]) => void)
      : null
  const forceOnConfirm = modalData.forceOnConfirm !== false
  const worktree = useMemo(() => {
    if (!worktreeId) {
      return null
    }
    const identity = worktreeDeleteIdentities.find((item) => item.id === worktreeId)
    return (
      allWorktrees.find(
        (item) => item.id === worktreeId && (!identity?.hostId || item.hostId === identity.hostId)
      ) ?? null
    )
  }, [allWorktrees, worktreeDeleteIdentities, worktreeId])
  const worktrees = useMemo(() => {
    if (worktreeIds.length === 0) {
      return []
    }
    if (worktreeDeleteIdentities.length > 0) {
      const selected = new Set(
        worktreeDeleteIdentities.map((identity) =>
          composeWorktreeHostIdentity(identity.hostId, identity.id)
        )
      )
      return allWorktrees.filter((item) => selected.has(getWorktreeHostIdentity(item)))
    }
    const selected = new Set(worktreeIds)
    return allWorktrees.filter((item) => selected.has(item.id))
  }, [allWorktrees, worktreeDeleteIdentities, worktreeIds])
  const repoMap = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const isBatchDelete = worktreeIds.length > 1
  const isFolderWorkspaceDelete = !isBatchDelete && getIsFolderWorkspaceDelete(repoMap, worktree)
  const folderWorkspaceDeleteCount = useMemo(
    () => countFolderWorkspaceDeletes(repoMap, worktrees),
    [repoMap, worktrees]
  )
  const deleteCopy = getDeleteWorktreeDialogCopy({
    isBatchDelete,
    worktree,
    worktreeCount: worktrees.length,
    folderWorkspaceDeleteCount,
    isFolderWorkspaceDelete
  })
  const deleteStateByWorktreeId = useAppStore((s) => s.deleteStateByWorktreeId)
  const lineageDelete = useMemo(
    () =>
      !isBatchDelete && worktree
        ? getWorkspaceDeleteLineage(worktree, allWorktrees, worktreeLineageById)
        : { descendants: [], deleteAllTargets: [] },
    [allWorktrees, isBatchDelete, worktree, worktreeLineageById]
  )
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  // Why: the main worktree is the repo's original clone directory — `git worktree remove`
  // always rejects it. We block the delete button upfront so the user doesn't have to
  // discover this limitation via a confusing force-delete dead-end.
  const isMainWorktree = !isBatchDelete && (worktree?.isMainWorktree ?? false)
  const childWorkspaceCount = lineageDelete.descendants.length
  const hasLineageChildren = childWorkspaceCount > 0
  const canDeleteAllLineage =
    !isMainWorktree && !isBatchDelete && lineageDelete.deleteAllTargets.length > 1
  const lineageFolderWorkspaceDeleteCount = useMemo(
    () => countFolderWorkspaceDeletes(repoMap, lineageDelete.deleteAllTargets),
    [lineageDelete.deleteAllTargets, repoMap]
  )
  const lineageDeleteCopy = getDeleteWorktreeLineageDialogCopy({
    childWorkspaceCount,
    deleteTargetCount: lineageDelete.deleteAllTargets.length,
    folderWorkspaceDeleteCount: lineageFolderWorkspaceDeleteCount
  })
  const allowSkipConfirm =
    !isBatchDelete && modalData.allowSkipConfirm !== false && childWorkspaceCount === 0
  const [dontAskAgain, setDontAskAgain] = useState(false)
  // Why: folder workspaces have no branch, and the main worktree cannot be deleted at all, so the
  // option would be noise in either case. The count comparison covers single and batch deletes.
  const showsRemoteBranchOption = !isMainWorktree && folderWorkspaceDeleteCount < worktrees.length
  const remoteBranch = useDeleteRemoteBranchChoice(
    isOpen,
    settings?.deleteRemoteBranchOnWorkspaceDelete ?? false
  )
  const deleteTargets = useMemo(
    () => (canDeleteAllLineage ? lineageDelete.deleteAllTargets : worktrees),
    [canDeleteAllLineage, lineageDelete.deleteAllTargets, worktrees]
  )
  const deleteStates = useMemo(
    () =>
      deleteTargets
        .map((target) => getDeleteStateForWorktreeHost(target, deleteStateByWorktreeId))
        .filter((state): state is NonNullable<typeof state> => state != null),
    [deleteStateByWorktreeId, deleteTargets]
  )
  const deleteState = worktree
    ? getDeleteStateForWorktreeHost(worktree, deleteStateByWorktreeId)
    : undefined
  const isDeleting = deleteStates.some((state) => state.isDeleting)
  const deleteError = !isBatchDelete ? (deleteState?.error ?? null) : null
  const canForceDelete = !isBatchDelete && (deleteState?.canForceDelete ?? false)
  const gitStatusByWorktreeIdentity = useDeleteWorktreeStatusHydration({
    isOpen,
    deleteTargets,
    visibleTargets: worktrees,
    repoMap
  })
  const dirtyChangeCountsByWorktreeId = useMemo(() => {
    return getDeleteWorktreeDirtyChangeCounts({
      deleteTargets,
      deleteStateByWorktreeId,
      gitStatusByWorktree,
      gitStatusByWorktreeIdentity,
      repoMap
    })
  }, [
    deleteStateByWorktreeId,
    deleteTargets,
    gitStatusByWorktree,
    gitStatusByWorktreeIdentity,
    repoMap
  ])

  if (!isOpen && dontAskAgain) {
    // Why: this checkbox is a one-shot dialog intent; reset it as soon as the
    // dialog is closed so a later delete never inherits a cancelled choice.
    setDontAskAgain(false)
  }

  useEffect(() => {
    if (isOpen && worktreeIds.length > 0 && worktrees.length === 0 && !isDeleting) {
      for (const target of deleteStateTargets) {
        clearWorktreeDeleteState(target.id, target.hostId)
      }
      closeModal()
    }
  }, [
    clearWorktreeDeleteState,
    closeModal,
    deleteStateTargets,
    isDeleting,
    isOpen,
    worktreeIds,
    worktreeIds.length,
    worktrees.length
  ])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return
      }
      const state = useAppStore.getState().deleteStateByWorktreeId
      const currentTarget = deleteStateTargets.find((target) => target.id === worktreeId)
      const currentState = currentTarget
        ? getDeleteStateForWorktreeHost(currentTarget, state)
        : undefined
      if (isBatchDelete) {
        for (const target of deleteStateTargets) {
          if (!getDeleteStateForWorktreeHost(target, state)?.isDeleting) {
            clearWorktreeDeleteState(target.id, target.hostId)
          }
        }
      } else if (worktreeId && !currentState?.isDeleting) {
        clearWorktreeDeleteState(worktreeId, currentTarget?.hostId)
      }
      closeModal()
    },
    [clearWorktreeDeleteState, closeModal, deleteStateTargets, isBatchDelete, worktreeId]
  )

  const persistDontAskAgainPreference = useCallback((): void => {
    persistDeleteWorktreeConfirmSkipPreference({
      updateSettings,
      openSettingsPage,
      openSettingsTarget
    })
  }, [openSettingsPage, openSettingsTarget, updateSettings])

  const handleForceDeletedFromToast = useCallback(
    (deletedTarget: WorktreeRemovalTarget): void => {
      onDeleted?.([deletedTarget])
    },
    [onDeleted]
  )

  const { handleDelete, handleDeleteAll } = useDeleteWorktreeDialogActions({
    worktreeId,
    worktreeIds,
    worktreeDeleteIdentities,
    lineageDeleteIdentities,
    lineageDeleteTargetCount: lineageDelete.deleteAllTargets.length,
    dontAskAgain,
    allowSkipConfirm,
    forceOnConfirm,
    deleteRemoteBranch: remoteBranch.checked,
    removeWorktree,
    resolveConfirmedTargets,
    persistDontAskAgainPreference,
    closeModal,
    onDeleted,
    onForceDeletedFromToast: handleForceDeletedFromToast
  })

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          if (isMainWorktree) {
            return
          }
          event.preventDefault()
          // Why: this confirmation dialog exists specifically to guard a
          // destructive action the user already chose from the context menu.
          // Radix otherwise picks the first tabbable control, which can be the
          // cancel/close affordance and breaks the expected "Delete, Enter"
          // flow for quick keyboard confirmation.
          confirmButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isBatchDelete
              ? translate(
                  'auto.components.sidebar.DeleteWorktreeDialog.86f0ae1257',
                  'Delete Workspaces'
                )
              : translate(
                  'auto.components.sidebar.DeleteWorktreeDialog.fc23c4cbdf',
                  'Delete Workspace'
                )}
          </DialogTitle>
          <DeleteWorktreeDialogDescription
            targetClassName={deleteCopy.targetClassName}
            targetLabel={deleteCopy.targetLabel}
            canDeleteAllLineage={canDeleteAllLineage}
            childTargetLabel={lineageDeleteCopy.childTargetLabel}
            descriptionSuffix={
              canDeleteAllLineage
                ? lineageDeleteCopy.descriptionSuffix
                : deleteCopy.descriptionSuffix
            }
          />
        </DialogHeader>

        <DeleteWorktreeTargetPreview
          isBatchDelete={isBatchDelete}
          worktree={worktree}
          worktrees={worktrees}
          collisionWorktrees={allWorktrees}
          hostLabelById={hostLabelById}
          deleteStateByWorktreeId={deleteStateByWorktreeId}
          dirtyChangeCountsByWorktreeId={dirtyChangeCountsByWorktreeId}
        />

        {hasLineageChildren && (
          <DeleteWorktreeLineageNotice
            descendants={lineageDelete.descendants}
            dirtyChangeCountsByWorktreeId={dirtyChangeCountsByWorktreeId}
          />
        )}

        <DeleteWorktreeWarningPanels
          isMainWorktree={isMainWorktree}
          mainWorktreeBlocker={deleteCopy.mainWorktreeBlocker}
          deleteError={deleteError}
        />

        {showsRemoteBranchOption && (
          <DeleteWorktreeRemoteBranchOption
            checked={remoteBranch.checked}
            onCheckedChange={remoteBranch.setChecked}
          />
        )}

        <DeleteWorktreeSkipConfirmOption
          showDontAskAgain={!isMainWorktree && allowSkipConfirm && !canForceDelete}
          dontAskAgain={dontAskAgain}
          onToggleDontAskAgain={() => setDontAskAgain((prev) => !prev)}
        />

        <DialogFooter>
          <DeleteWorktreeDialogFooter
            isMainWorktree={isMainWorktree}
            isDeleting={isDeleting}
            canForceDelete={canForceDelete}
            isBatchDelete={isBatchDelete}
            worktreeCount={worktrees.length}
            canDeleteAllLineage={canDeleteAllLineage}
            lineageDeleteTargetCount={lineageDelete.deleteAllTargets.length}
            onCancel={() => handleOpenChange(false)}
            onForceDelete={() => handleDelete(true)}
            onDelete={canDeleteAllLineage ? handleDeleteAll : () => handleDelete(false)}
            confirmButtonRef={confirmButtonRef}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default DeleteWorktreeDialog
