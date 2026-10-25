import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'

export type WorktreeRemovalInFlight = {
  optionsKey: string
  promise: Promise<RemoveWorktreeResult>
}

export function getWorktreeRemovalOptionsKey(
  args: Pick<
    RemoveWorktreeArgs,
    | 'force'
    | 'allowUnverifiedPtyStop'
    | 'skipArchive'
    | 'allowFailedArchiveHook'
    | 'approvedNestedWorktrees'
    | 'expectedCheckout'
    | 'deleteRemoteBranch'
  >
): string {
  const forceKey = args.force === true ? 'force' : 'normal'
  const archiveKey = args.skipArchive === true ? 'skip-archive' : 'run-archive'
  // Explicit PTY-stop waivers must retry instead of joining the strict attempt that just refused.
  const ptyKey = args.allowUnverifiedPtyStop === true ? 'allow-unverified-pty' : 'require-pty-stop'
  // Failed-hook waivers likewise require a separate attempt from strict removal.
  const archiveFailureKey =
    args.allowFailedArchiveHook === true ? 'allow-failed-archive' : 'require-archive'
  // A retry that now asks for the remote branch to go must not join an attempt that was told to leave it.
  const remoteBranchKey =
    args.deleteRemoteBranch === true ? 'delete-remote-branch' : 'keep-remote-branch'
  const checkoutKey =
    args.approvedNestedWorktrees || args.expectedCheckout
      ? `:${JSON.stringify([args.approvedNestedWorktrees, args.expectedCheckout])}`
      : ''
  return `${forceKey}:${archiveKey}:${ptyKey}:${archiveFailureKey}:${remoteBranchKey}${checkoutKey}`
}

export function getWorktreeRemovalInFlightKey(
  worktreeId: string,
  hostId?: ExecutionHostId
): string {
  return `${hostId ?? ''}\0${worktreeId}`
}
