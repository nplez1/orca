import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { confirmUnsavedDiscard } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import type { WorktreeDeleteIdentity } from './worktree-delete-request'
import { runDialogForceDelete } from './delete-worktree-dialog-force-delete'
import { runLineageDeleteAll } from './delete-worktree-lineage-delete-all'
import { runWorktreeDeletesInParallel } from './delete-worktree-flow'

type RemoveWorktreeForDialog = Parameters<typeof runDialogForceDelete>[0]['removeWorktree']
type UnsavedTargets = Parameters<typeof confirmUnsavedDiscard>[1]
type ResolveConfirmedTargets = Parameters<typeof runLineageDeleteAll>[0]['resolveConfirmedTargets']

/**
 * The delete dialog's two destructive actions, split out of the component because they carry the
 * bulk of its lines — including both dependency arrays.
 */
export function useDeleteWorktreeDialogActions(args: {
  worktreeId: string
  worktreeIds: readonly string[]
  worktreeDeleteIdentities: readonly WorktreeDeleteIdentity[]
  lineageDeleteIdentities: readonly WorktreeDeleteIdentity[]
  lineageDeleteTargetCount: number
  dontAskAgain: boolean
  allowSkipConfirm: boolean
  forceOnConfirm: boolean
  /** The user opted into deleting the remote branch on this delete. */
  deleteRemoteBranch: boolean
  /** Targets whose unsaved edits the dialog lists before the delete runs. */
  unsavedTargets: UnsavedTargets
  removeWorktree: RemoveWorktreeForDialog
  resolveConfirmedTargets: ResolveConfirmedTargets
  persistDontAskAgainPreference: () => void
  closeModal: () => void
  onDeleted: ((deleted: WorktreeRemovalTarget[]) => void) | null | undefined
  onForceDeletedFromToast: (target: WorktreeRemovalTarget) => void
}): { handleDelete: (force?: boolean) => void; handleDeleteAll: () => void } {
  const {
    worktreeId,
    worktreeIds,
    worktreeDeleteIdentities,
    lineageDeleteIdentities,
    lineageDeleteTargetCount,
    dontAskAgain,
    allowSkipConfirm,
    forceOnConfirm,
    deleteRemoteBranch,
    unsavedTargets,
    removeWorktree,
    resolveConfirmedTargets,
    persistDontAskAgainPreference,
    closeModal,
    onDeleted,
    onForceDeletedFromToast
  } = args
  const worktreeCount = worktreeIds.length
  // Memoized so the callbacks below keep a stable dependency while the choice is unchanged.
  const remoteBranchOptions = useMemo(
    () => (deleteRemoteBranch ? { deleteRemoteBranch: true as const } : {}),
    [deleteRemoteBranch]
  )

  const handleDelete = useCallback(
    (force = false) => {
      if (worktreeCount === 0) {
        return
      }
      const currentWorktrees = resolveConfirmedTargets(worktreeDeleteIdentities, worktreeCount)
      if (!currentWorktrees) {
        return
      }
      const confirmedDiscards = confirmUnsavedDiscard(useAppStore.getState, unsavedTargets)
      // Why: force-delete is a recovery path taken after a failed first delete. Saving
      // "don't ask again" from that state would conflate the recovery action with a broader
      // preference, so only the primary (non-force) confirmation persists it.
      if (dontAskAgain && allowSkipConfirm && !force) {
        persistDontAskAgainPreference()
      }
      if (force) {
        runDialogForceDelete({
          worktreeId,
          currentWorktrees,
          removeWorktree,
          closeModal,
          onDeleted,
          confirmedDiscards,
          ...remoteBranchOptions
        })
        return
      }
      // Why: this modal is the destructive confirmation for the workspace folder. Running a
      // non-force remove here just turns dirty files into a redundant Force Delete toast after
      // the user already confirmed.
      const deletePromise = runWorktreeDeletesInParallel(currentWorktrees, {
        force: forceOnConfirm,
        ...remoteBranchOptions,
        confirmedDiscards,
        onForceDeleted: onForceDeletedFromToast
      })
      // Why: the workspace card owns the in-progress feedback, so the confirmation should get
      // out of the way as soon as deletion begins.
      closeModal()
      void deletePromise.then((deletedTargets) => {
        if (deletedTargets.length > 0) {
          onDeleted?.(deletedTargets)
        }
      })
    },
    [
      allowSkipConfirm,
      closeModal,
      dontAskAgain,
      forceOnConfirm,
      onDeleted,
      onForceDeletedFromToast,
      persistDontAskAgainPreference,
      remoteBranchOptions,
      removeWorktree,
      resolveConfirmedTargets,
      worktreeCount,
      worktreeDeleteIdentities,
      unsavedTargets,
      worktreeId
    ]
  )

  const handleDeleteAll = useCallback(() => {
    runLineageDeleteAll({
      deleteAllTargetCount: lineageDeleteTargetCount,
      lineageDeleteIdentities,
      resolveConfirmedTargets,
      forceOnConfirm,
      ...remoteBranchOptions,
      confirmedDiscards: confirmUnsavedDiscard(useAppStore.getState, unsavedTargets),
      onForceDeleted: onForceDeletedFromToast,
      closeModal,
      onDeleted
    })
  }, [
    closeModal,
    forceOnConfirm,
    lineageDeleteIdentities,
    lineageDeleteTargetCount,
    onDeleted,
    onForceDeletedFromToast,
    remoteBranchOptions,
    resolveConfirmedTargets,
    unsavedTargets
  ])

  return { handleDelete, handleDeleteAll }
}
