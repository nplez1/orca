import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { callRuntimeRpc, type getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../../../runtime/runtime-worktree-selector'
import type { RemoveWorktreeOptions } from '../../worktree-removal-options'
import { ARCHIVE_HOOK_TIMEOUT_MS } from '../../../../../../shared/worktree/archive-hook-removal-gate'

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
  forgetLocalOnly: boolean
  target: ReturnType<typeof getActiveRuntimeTarget>
  options: RemoveWorktreeOptions | undefined
  /** Re-checks mid-flight ownership immediately before the destructive call. */
  assertCurrent: () => void
}): Promise<RemoveWorktreeResult> {
  const { worktreeId, hostId, force, skipArchive, forgetLocalOnly, target, options } = args
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
      // Why not a flat 60s (#19334): the host may run an archive hook for up to
      // ARCHIVE_HOOK_TIMEOUT_MS before it decides anything. A client that gives up first reports a
      // failure for a removal that is still in progress — and if the hook then succeeds, the host
      // deletes the checkout while the user has been told the delete failed. Outlast the hook when
      // one can run; keep the short budget when none will.
      timeoutMs: skipArchive ? 60_000 : ARCHIVE_HOOK_TIMEOUT_MS + 60_000
    }
  )
  if (options?.deleteRemoteBranch !== true || result.remoteBranchCleanup) {
    return result
  }
  // Why: a host that never heard of the param drops it and answers without a cleanup, so the
  // outcome has to say `failed` rather than let silence read as "the branch is gone". The
  // sentence the user reads is the toast's; this field carries Git's own text, which the host
  // never sent. Deliberately not "older host": a current host also omits the field on its
  // unregistered/stale/orphan-folder removal paths, where no local branch was deleted and the
  // remote branch was correctly left alone.
  return {
    ...result,
    remoteBranchCleanup: {
      status: 'failed' as const
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
