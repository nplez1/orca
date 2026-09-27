import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { PreservedBranchCleanup } from '../../../../../../shared/preserved-branch-cleanup'
import { preservedBranchCleanupKey } from '../../../../../../shared/preserved-branch-cleanup'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { showPreservedBranchToast } from '@/components/sidebar/preserved-branch-toast'
import type { getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import { preservedBranchRuntimeTargetByCleanupKey } from './preserved-branch-cleanup-target'

export type PreservedBranchToastWorktree = Parameters<typeof showPreservedBranchToast>[1]

/**
 * Records where a preserved branch will be cleaned up and offers the force-delete
 * toast, returning the branch as the removal result should report it.
 *
 * Why shared: the ordinary removal path and the same-id host-scoped completion both
 * end here, and they must agree on the cleanup key — the toast resolves the target
 * through the same key this writes.
 */
export function finalizePreservedBranchRemoval(
  removalResult: RemoveWorktreeResult | undefined,
  options: {
    worktreeId: string
    hostId: ExecutionHostId | undefined
    runtimeEnvironmentId: string | null | undefined
    target: ReturnType<typeof getActiveRuntimeTarget>
    worktreeBeforeRemoval: PreservedBranchToastWorktree | undefined
    suppressToast: boolean
    onForceDelete: (branchName: string, expectedHead: string) => void
  }
): RemoveWorktreeResult['preservedBranch'] | null {
  const preservedBranch = removalResult?.preservedBranch
  if (!preservedBranch) {
    return null
  }
  const cleanup: PreservedBranchCleanup = {
    worktreeId: options.worktreeId,
    branchName: preservedBranch.branchName,
    expectedHead: preservedBranch.head,
    ...(options.hostId ? { hostId: options.hostId } : {}),
    ...(options.runtimeEnvironmentId ? { runtimeEnvironmentId: options.runtimeEnvironmentId } : {})
  }
  preservedBranchRuntimeTargetByCleanupKey.set(preservedBranchCleanupKey(cleanup), {
    cleanup,
    target: options.target
  })
  if (!options.suppressToast) {
    showPreservedBranchToast(removalResult, options.worktreeBeforeRemoval, options.onForceDelete)
  }
  return {
    ...preservedBranch,
    ...(cleanup.hostId ? { hostId: cleanup.hostId } : {}),
    ...(cleanup.runtimeEnvironmentId ? { runtimeEnvironmentId: cleanup.runtimeEnvironmentId } : {})
  }
}
