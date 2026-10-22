import {
  isRuntimeOwnedSshTargetId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { EphemeralVmRuntimeRecord } from '../../../shared/ephemeral-vm-runtimes'

/**
 * Tear down the ephemeral-VM runtimes backing a set of deleted workspaces (and,
 * optionally, runtimes pinned to a removed repo's runtime-owned SSH target).
 *
 * Centralized because both the per-workspace delete (`removeWorktree`) and the
 * project removal (`removeProject`) must clean up the runtime — an SSH-mode
 * per-workspace-env's workspace is the repo's *main* worktree, so deleting it
 * routes through project removal, which must not leak the live Docker/VM and its
 * hidden SSH target.
 *
 * Classifies runtime-owned SSH targets so callers purge only confirmed-destroyed projects.
 */
export type EphemeralVmCleanupSummary = {
  destroyedSshTargetIds: string[]
  retainedSshTargetIds: string[]
  /** Runtimes whose destroy ran: the provider was asked to release these machines. */
  releasedRuntimeIds: string[]
  /** Runtimes whose recipe declares no destroy, so only their provider lease releases them. */
  destroyDisabledRuntimeIds: string[]
  /** Runtimes whose destroy failed: their machines may still be allocated. */
  failedRuntimeIds: string[]
  /**
   * Every runtime matched to the request, whatever its state — including ones whose machine was
   * already released or reclaimed, and which therefore ran no destroy here.
   */
  matchedRuntimeIds: string[]
}

/**
 * Which runtime records a deletion request names.
 *
 * Why shared: a delete has to decide *before* it acts whether Orca owns the machine behind a
 * workspace, and that decision must name exactly the records the cleanup would then destroy — a
 * second spelling would let the two disagree about one record.
 */
function createRuntimeMatcher(args: {
  workspaceIds?: readonly string[]
  hostScopedWorkspaces?: readonly { workspaceId: string; executionHostId: ExecutionHostId }[]
  runtimeOwnedSshTargetIds?: readonly string[]
}): (runtime: EphemeralVmRuntimeRecord) => boolean {
  const workspaceIdSet = new Set(args.workspaceIds ?? [])
  const sshTargetIdSet = new Set(
    (args.runtimeOwnedSshTargetIds ?? []).filter((id) => isRuntimeOwnedSshTargetId(id))
  )
  const hostScopedWorkspaceIdentities = new Set(
    (args.hostScopedWorkspaces ?? []).map((target) =>
      composeWorktreeHostIdentity(target.executionHostId, target.workspaceId)
    )
  )
  return (runtime) =>
    (runtime.workspaceId !== undefined && workspaceIdSet.has(runtime.workspaceId)) ||
    (runtime.workspaceId !== undefined &&
      ((runtime.runtimeEnvironmentId !== undefined &&
        hostScopedWorkspaceIdentities.has(
          composeWorktreeHostIdentity(
            toRuntimeExecutionHostId(runtime.runtimeEnvironmentId),
            runtime.workspaceId
          )
        )) ||
        (runtime.sshTargetId !== undefined &&
          hostScopedWorkspaceIdentities.has(
            composeWorktreeHostIdentity(
              toSshExecutionHostId(runtime.sshTargetId),
              runtime.workspaceId
            )
          )))) ||
    (runtime.sshTargetId !== undefined && sshTargetIdSet.has(runtime.sshTargetId))
}

export async function cleanupEphemeralVmRuntimesForDeleted(args: {
  workspaceIds?: readonly string[]
  /** Workspace owners whose same-id siblings on other hosts must survive. */
  hostScopedWorkspaces?: readonly {
    workspaceId: string
    executionHostId: ExecutionHostId
  }[]
  // Raw runtime-owned SSH target ids (e.g. a removed repo's connectionId) whose
  // backing runtime should also be torn down, even if no workspace id matched.
  runtimeOwnedSshTargetIds?: readonly string[]
}): Promise<EphemeralVmCleanupSummary> {
  const destroyedSshTargetIds = new Set<string>()
  const retainedSshTargetIds = new Set<string>()
  const releasedRuntimeIds = new Set<string>()
  const destroyDisabledRuntimeIds = new Set<string>()
  const failedRuntimeIds = new Set<string>()
  const matchedRuntimeIds = new Set<string>()
  try {
    const matchesRequest = createRuntimeMatcher(args)
    const runtimes = await window.api.ephemeralVm.listRuntimes()
    const matchingRuntimes = runtimes.filter((runtime) => {
      if (!matchesRequest(runtime)) {
        return false
      }
      matchedRuntimeIds.add(runtime.id)
      // Why a reclaimed host is never matched: its records were already released because the
      // provider's lease lapsed and the machine stopped answering. Removing its workspace row is
      // Orca forgetting a host it cannot use — not a reason to run the recipe's `destroy`, which
      // could delete a machine that is still alive with the user's work on it.
      return (
        runtime.reclaimedAt === undefined &&
        (runtime.cleanupStatus !== 'succeeded' || runtime.sshTargetId !== undefined)
      )
    })
    for (const runtime of matchingRuntimes) {
      try {
        const cleaned = await window.api.ephemeralVm.cleanup({ runtimeId: runtime.id })
        // Why the returned record and not "it did not throw": the IPC answers a failed destroy
        // with the record itself, so only the status says whether the machine was released.
        if (cleaned.cleanupStatus === 'failed') {
          failedRuntimeIds.add(runtime.id)
        } else if (cleaned.cleanupStatus === 'disabled') {
          destroyDisabledRuntimeIds.add(runtime.id)
        } else {
          releasedRuntimeIds.add(runtime.id)
        }
        if (runtime.sshTargetId) {
          const targetIds = cleaned.sshTargetId ? retainedSshTargetIds : destroyedSshTargetIds
          targetIds.add(runtime.sshTargetId)
        }
      } catch (error) {
        console.error('Failed to clean up ephemeral VM runtime for deleted workspace:', error)
        failedRuntimeIds.add(runtime.id)
        if (runtime.sshTargetId) {
          retainedSshTargetIds.add(runtime.sshTargetId)
        }
      }
    }
  } catch (error) {
    console.error('Failed to clean up ephemeral VM runtime for deleted workspace:', error)
    for (const targetId of args.runtimeOwnedSshTargetIds ?? []) {
      if (isRuntimeOwnedSshTargetId(targetId)) {
        retainedSshTargetIds.add(targetId)
      }
    }
  }
  return {
    destroyedSshTargetIds: [...destroyedSshTargetIds],
    retainedSshTargetIds: [...retainedSshTargetIds],
    releasedRuntimeIds: [...releasedRuntimeIds],
    destroyDisabledRuntimeIds: [...destroyDisabledRuntimeIds],
    failedRuntimeIds: [...failedRuntimeIds],
    matchedRuntimeIds: [...matchedRuntimeIds]
  }
}

/**
 * The runtime records this deletion request names, without touching any of them.
 *
 * Why a read-only peek: a delete has to decide whether Orca owns the machine behind a workspace
 * before it destroys anything, and the teardown that then runs the destroy must stay the only
 * writer — so the decision cannot be the cleanup.
 */
export async function listEphemeralVmRuntimesForWorkspace(args: {
  workspaceId: string
  executionHostId: ExecutionHostId | null | undefined
}): Promise<EphemeralVmRuntimeRecord[]> {
  const matchesRequest = createRuntimeMatcher(
    args.executionHostId
      ? {
          hostScopedWorkspaces: [
            { workspaceId: args.workspaceId, executionHostId: args.executionHostId }
          ]
        }
      : { workspaceIds: [args.workspaceId] }
  )
  const runtimes = await window.api.ephemeralVm.listRuntimes()
  return runtimes.filter(matchesRequest)
}
