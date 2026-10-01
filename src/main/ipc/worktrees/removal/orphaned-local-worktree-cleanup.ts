import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { LocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { gitExecFileAsync } from '../../../git/runner'
import { cleanupLocalOrphanedWorktreeDirectory } from '../../../local-orphaned-worktree-cleanup'
import { cleanupUnusedWorktreePushTargetRemote } from '../../worktree-remote'
import { invalidateAuthorizedRootsCache } from '../../registered-worktree-roots-cache'
import { preservedBranchCleanupScopeKey } from '../../../../shared/preserved-branch-cleanup'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { preservedBranchCleanupByScope } from './preserved-branch-cleanup'
import { removeWorktreeMetadataAndTransientState } from './worktree-removal-ownership'

/**
 * Finishes a removal Git refused because it no longer tracks the worktree: the directory, the
 * stale admin record, the push-target remote, and the metadata all have to go, or `git worktree
 * remove` failed with nothing left to remove it.
 */
export async function cleanupOrphanedLocalWorktreeRemoval(args: {
  context: WorktreeIpcContext
  canonicalWorktreePath: string
  removalHostId: ExecutionHostId
  removedPushTarget: GitPushTarget | undefined
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions
  repoPath: string
  worktreeId: string
  snapshotPruneBatchId?: string
}): Promise<void> {
  const { store, runtime } = args.context
  console.warn(
    `[worktrees] Orphaned worktree detected at ${args.canonicalWorktreePath}, cleaning up`
  )
  await cleanupLocalOrphanedWorktreeDirectory(
    args.repoPath,
    args.canonicalWorktreePath,
    args.localWorktreeGitOptions,
    (path) => runtime.closeFileWatchersForRemoval(path)
  )
  // Why: remove failed so git still tracks it (.git/worktrees/<name>); prune or the stale entry keeps its branch locked.
  await gitExecFileAsync(['worktree', 'prune'], {
    cwd: args.repoPath,
    ...args.localWorktreeGitOptions
  }).catch(() => {})
  await cleanupUnusedWorktreePushTargetRemote(
    args.repoPath,
    args.worktreeId,
    args.removedPushTarget,
    store,
    args.localWorktreeGitOptions
  )
  runtime.clearOptimisticReconcileToken(args.worktreeId)
  removeWorktreeMetadataAndTransientState(
    store,
    args.worktreeId,
    args.removalHostId,
    args.snapshotPruneBatchId
  )
  preservedBranchCleanupByScope.delete(
    preservedBranchCleanupScopeKey({
      worktreeId: args.worktreeId,
      hostId: args.removalHostId
    })
  )
  invalidateAuthorizedRootsCache()
}
