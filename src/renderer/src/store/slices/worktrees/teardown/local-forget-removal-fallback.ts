/**
 * The two failures a delete can answer by acting on Orca's own record instead of the host's.
 *
 * Why together: both end in the same place — `worktrees:forgetLocal` drops the row — and both run
 * inside the one catch that wraps the destructive call. Keeping them in the slice pushed that file
 * past its line budget and hid the shape of the recovery next to 200 lines of teardown.
 */
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import type { WorktreeOperationGenerationGuard } from '@/lib/worktree-operation-generation'
import {
  resolveWorktreeOperationRouteResult,
  resolveWorktreeOperationRouteResultForHost
} from '@/lib/worktree-operation-route'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import {
  isRuntimeRepoNotFoundError,
  isRuntimeSelectorNotFoundError
} from '../listing/runtime-worktree-rpc-errors'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { resolveUnreachableVmRemovalFallback } from './unreachable-vm-workspace-release'

export type LocalForgetRemovalFallback =
  /** Neither case applies: the caller keeps its ordinary failure. */
  | { kind: 'not-applicable' }
  | {
      kind: 'forget-locally'
      result: RemoveWorktreeResult
      /** The host never answered and Orca owns its machine, so the delete reports on it. */
      unreachableOrcaMachine: boolean
    }

async function forgetRemovedWorkspace(args: {
  worktreeId: string
  hostId: ExecutionHostId | undefined
  snapshotPruneBatchId: string | undefined
  /** The host's own verdict, kept as context when even the local forget fails. */
  cause: unknown
}): Promise<RemoveWorktreeResult> {
  try {
    return await window.api.worktrees.forgetLocal({
      worktreeId: args.worktreeId,
      hostId: args.hostId,
      ...(args.snapshotPruneBatchId ? { snapshotPruneBatchId: args.snapshotPruneBatchId } : {})
    })
  } catch (fallbackError) {
    throw new Error(
      fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      { cause: args.cause }
    )
  }
}

/**
 * Resolve whether a failed `worktree.rm` still lets Orca drop the row itself.
 *
 * - the host's mirror does not know the workspace (`repo_not_found` / `selector_not_found`), or
 * - the host stopped answering and the machine behind it is one Orca allocated.
 *
 * Why the second case only ever asks once: the row is what the user is trying to delete, and a
 * machine Orca owns is released now or left to its provider lease — neither is a reason to keep a
 * workspace Orca can never reach again. The one thing that stops it is an archive hook the user
 * approved, waived by the same "Delete Anyway" a failed hook uses.
 */
export async function resolveLocalForgetRemovalFallback(args: {
  error: unknown
  worktreeId: string
  hostId: ExecutionHostId | undefined
  requiredExecutionHostId: ExecutionHostId | null
  target: RuntimeClientTarget
  generationGuard: WorktreeOperationGenerationGuard | null
  get: WorktreeSliceGet
  snapshotPruneBatchId: string | undefined
  worktreePath: string
  allowFailedArchiveHook: boolean
}): Promise<LocalForgetRemovalFallback> {
  const { error, worktreeId, hostId, requiredExecutionHostId, target, generationGuard, get } = args
  const forgetLocally = async (unreachableOrcaMachine: boolean) => ({
    kind: 'forget-locally' as const,
    result: await forgetRemovedWorkspace(forgetArgs),
    unreachableOrcaMachine
  })
  const forgetArgs = {
    worktreeId,
    hostId,
    snapshotPruneBatchId: args.snapshotPruneBatchId,
    cause: error
  }

  if (
    target.kind !== 'local' &&
    (isRuntimeRepoNotFoundError(error) || isRuntimeSelectorNotFoundError(error))
  ) {
    // Missing means stale mirror; ambiguous or changed ownership must fail closed.
    const currentResolution = requiredExecutionHostId
      ? resolveWorktreeOperationRouteResultForHost(get(), worktreeId, requiredExecutionHostId)
      : resolveWorktreeOperationRouteResult(get(), worktreeId)
    if (currentResolution.kind === 'ambiguous') {
      throw error
    }
    if (currentResolution.kind === 'resolved') {
      generationGuard?.assertCurrent()
    }
    return forgetLocally(false)
  }

  // Why the guard first: the decision below is what licenses the teardown to release a machine, so
  // a superseded removal must stop before anything is decided on its behalf.
  generationGuard?.assertCurrent()
  const vmFallback = await resolveUnreachableVmRemovalFallback({
    error,
    worktreeId,
    worktreePath: args.worktreePath,
    hostId: requiredExecutionHostId ?? hostId,
    repoId: getRepoIdFromWorktreeId(worktreeId),
    allowFailedArchiveHook: args.allowFailedArchiveHook,
    get
  })
  if (vmFallback.kind === 'not-applicable') {
    return { kind: 'not-applicable' }
  }
  generationGuard?.assertCurrent()
  return forgetLocally(true)
}
