import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { PreservedBranchCleanup } from '../../../../../../shared/preserved-branch-cleanup'
import type {
  PreservedWorktreeBranch,
  RemoveWorktreeResult
} from '../../../../../../shared/worktree/create-types'
import type { RendererRemoveWorktreeResult } from '../../renderer-remove-worktree-result'

/**
 * How a removal reports a preserved branch back to its caller and remembers how to delete it later.
 * Both builders rebuild literals field by field, so every field a caller can read must be named.
 */

export function buildPreservedBranchCleanup(args: {
  worktreeId: string
  preservedBranch: PreservedWorktreeBranch
  hostId: ExecutionHostId | undefined
  runtimeEnvironmentId: string | null | undefined
}): PreservedBranchCleanup {
  return {
    worktreeId: args.worktreeId,
    branchName: args.preservedBranch.branchName,
    expectedHead: args.preservedBranch.head,
    ...(args.hostId ? { hostId: args.hostId } : {}),
    ...(args.runtimeEnvironmentId ? { runtimeEnvironmentId: args.runtimeEnvironmentId } : {})
  }
}

export function buildWorktreeRemovalSuccessResult(args: {
  preservedBranch: PreservedWorktreeBranch | undefined
  cleanup: PreservedBranchCleanup | null
  remoteBranchCleanup: RemoveWorktreeResult['remoteBranchCleanup']
}): { ok: true } & RendererRemoveWorktreeResult {
  const { preservedBranch, cleanup, remoteBranchCleanup } = args
  // Why: `remoteBranchCleanup` is optional in the type, so omitting it typechecks and then
  // silently reports nothing about a remote branch the user asked to delete.
  return preservedBranch && cleanup
    ? {
        ok: true,
        ...(remoteBranchCleanup ? { remoteBranchCleanup } : {}),
        preservedBranch: {
          ...preservedBranch,
          ...(cleanup.hostId ? { hostId: cleanup.hostId } : {}),
          ...(cleanup.runtimeEnvironmentId
            ? { runtimeEnvironmentId: cleanup.runtimeEnvironmentId }
            : {})
        }
      }
    : { ok: true, ...(remoteBranchCleanup ? { remoteBranchCleanup } : {}) }
}
