import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { callRuntimeRpc, type getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../../../runtime/runtime-worktree-selector'
import type { RemoveWorktreeOptions } from '../../worktree-removal-options'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import {
  isWorktreeRemovalReplyLost,
  settleLostWorktreeRemovalReply
} from './host-worktree-removal-state'
import { worktreeRemovalReplyTimeoutMs } from '../../../../../../shared/worktree/archive-hook-removal-gate'

/**
 * Sends the destructive removal over whichever transport owns this workspace.
 *
 * `hostId` rides every branch: local main resolves the owner from it, and the
 * runtime RPC needs it because a `repoId::path` selector alone repeats across
 * hosts (STA-4343).
 */
export async function dispatchWorktreeRemoval(args: {
  worktreeId: string
  hostId: ExecutionHostId | undefined
  force: boolean | undefined
  skipArchive: boolean
  get: WorktreeSliceGet
  target: ReturnType<typeof getActiveRuntimeTarget>
  options: RemoveWorktreeOptions | undefined
  /** Re-checks mid-flight ownership immediately before the destructive call. */
  assertCurrent: () => void
}): Promise<RemoveWorktreeResult> {
  try {
    return await requestWorktreeRemoval(args)
  } catch (error) {
    if (args.options?.mode === 'forget-local' || !isWorktreeRemovalReplyLost(error)) {
      throw error
    }
    // Why: the host may still be deleting; its listing answers what the lost reply would have.
    await settleLostWorktreeRemovalReply(args.get, {
      worktreeId: args.worktreeId,
      hostId: args.hostId,
      replyError: error
    })
    return {}
  }
}

async function requestWorktreeRemoval(
  args: Parameters<typeof dispatchWorktreeRemoval>[0]
): Promise<RemoveWorktreeResult> {
  const { worktreeId, hostId, force, skipArchive, target, options } = args
  const forgetLocalOnly = options?.mode === 'forget-local'
  const snapshotPruneBatch = options?.snapshotPruneBatchId
    ? { snapshotPruneBatchId: options.snapshotPruneBatchId }
    : {}
  if (forgetLocalOnly) {
    return window.api.worktrees.forgetLocal({ worktreeId, hostId, ...snapshotPruneBatch })
  }
  args.assertCurrent()
  if (target.kind === 'local') {
    return window.api.worktrees.remove({
      worktreeId,
      hostId,
      force,
      allowUnverifiedPtyStop: options?.allowUnverifiedPtyStop === true,
      allowFailedArchiveHook: options?.allowFailedArchiveHook === true,
      ...(options?.deleteRemoteBranch === true ? { deleteRemoteBranch: true } : {}),
      skipArchive,
      ...snapshotPruneBatch
    })
  }
  const effectiveHostId =
    options?.sameIdSurvivingHostId != null ? hostId : qualifyRuntimeCallHost(target, hostId)
  const result = await callRuntimeRpc<RemoveWorktreeResult>(
    target,
    'worktree.rm',
    {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      ...(effectiveHostId ? { hostId: effectiveHostId } : {}),
      force,
      allowUnverifiedPtyStop: options?.allowUnverifiedPtyStop === true,
      // Why only when set, unlike the IPC branch: this crosses a version boundary, and a host
      // that predates the gate drops unknown params silently. Send it when it means something.
      ...(options?.allowFailedArchiveHook === true ? { allowFailedArchiveHook: true } : {}),
      ...(options?.deleteRemoteBranch === true ? { deleteRemoteBranch: true } : {}),
      runHooks: !skipArchive
    },
    {
      // Why (#19334): the host may run an archive hook before it decides anything, then waits for
      // Git's delete before it replies; outlast both when a hook can run.
      timeoutMs: worktreeRemovalReplyTimeoutMs(!skipArchive)
    }
  )
  if (options?.deleteRemoteBranch !== true || result.remoteBranchCleanup) {
    return result
  }
  // Why: a host that never heard of the param drops it and answers without a cleanup, so silence
  // would leave the user believing the remote branch is gone. Deliberately not "older host": a
  // current host also omits the field on its unregistered/stale/orphan-folder removal paths, where
  // no local branch was deleted and the remote branch was correctly left alone.
  return {
    ...result,
    remoteBranchCleanup: {
      status: 'failed' as const,
      message:
        'The connected host did not report deleting the remote branch. Check the branch on its remote before assuming it is gone.'
    }
  }
}

function qualifyRuntimeCallHost(
  target: ReturnType<typeof getActiveRuntimeTarget>,
  hostId: ExecutionHostId | undefined
): ExecutionHostId | undefined {
  const parsedHost = parseExecutionHostId(hostId)
  if (
    target.kind === 'environment' &&
    parsedHost?.kind === 'runtime' &&
    parsedHost.environmentId === target.environmentId
  ) {
    return undefined
  }
  return hostId
}
