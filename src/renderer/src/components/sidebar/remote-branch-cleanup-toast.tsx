import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { RemoteBranchCleanup } from '../../../../shared/worktree/remote-branch-removal'

/** The branch as the user named it, or the remote ref when no local name was carried back. */
function branchLabel(cleanup: RemoteBranchCleanup): string {
  return cleanup.branchName ?? cleanup.remoteName ?? ''
}

/**
 * Reports a remote-branch delete the user opted into.
 *
 * A `deleted` outcome says nothing — the dialog already promised it, and a toast per workspace
 * would be noise in a batch delete. Every other outcome is surfaced, because each one means the
 * branch is still on the server while the workspace it belonged to is gone.
 */
export function showRemoteBranchCleanupNotice(
  worktreeName: string,
  cleanup: RemoteBranchCleanup
): void {
  if (cleanup.status === 'deleted') {
    return
  }
  const id = `remote-branch-cleanup:${worktreeName}:${cleanup.status}`
  if (cleanup.status === 'failed') {
    toast.error(
      translate(
        'auto.components.sidebar.remote.branch.cleanup.toast.failed',
        'Could not delete the remote branch for {{value0}}',
        { value0: worktreeName }
      ),
      { id, description: cleanup.message, duration: 12000, dismissible: true }
    )
    return
  }
  const description = {
    'already-absent': translate(
      'auto.components.sidebar.remote.branch.cleanup.toast.alreadyAbsent',
      'The remote had no branch named {{value0}}.',
      { value0: branchLabel(cleanup) }
    ),
    'no-upstream': translate(
      'auto.components.sidebar.remote.branch.cleanup.toast.noUpstream',
      'This branch tracks no remote branch, so nothing was deleted there.'
    ),
    'skipped-preserved': translate(
      'auto.components.sidebar.remote.branch.cleanup.toast.skippedPreserved',
      'Orca kept the local branch, so it left the remote branch in place too.'
    )
  }[cleanup.status]
  toast.info(
    translate(
      'auto.components.sidebar.remote.branch.cleanup.toast.keptTitle',
      'Remote branch kept for {{value0}}',
      { value0: worktreeName }
    ),
    { id, description, duration: 10000, dismissible: true }
  )
}
