import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import {
  getWorktreeOperationOwnerHostIds,
  type WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import {
  onEphemeralVmRuntimesPublished,
  refreshEphemeralVmRuntimes
} from '@/hooks/useEphemeralVmRuntimes'
import type { WorktreeSlice } from '../../store/slices/worktree-helpers'
import { useAppStore } from '../../store'

/**
 * The store surface this bridge drives, so a test can supply the removal instead of running it.
 */
export type EphemeralVmReclaimStore = {
  getState: () => WorktreeOperationRouteState & Pick<WorktreeSlice, 'removeWorktree'>
}

/**
 * What matching a reclaimed host to a workspace row needs.
 *
 * Why not the event type directly: the live event and a reconcile read from the persisted record
 * carry the same identities in different spellings, and only the intersection matters here.
 */
type EphemeralVmReclaimMatchInput = {
  workspaceId?: string
  hostIds: readonly string[]
}

/**
 * The row that belongs to the host that was just reclaimed, or null when none does.
 *
 * Why the intersection with the reclaimed host's own identities: one workspace id can exist on
 * several hosts at once — two VMs from the same recipe with a fixed `projectRoot` produce the same
 * id — so picking any row with a matching id would forget a live sibling's workspace instead of the
 * dead host's. The identities come from the runtime record, so a same-id local row can never match
 * and needs no separate exclusion. Why `runtime:` wins a tie: one VM is often reachable as both
 * `runtime:<env>` and `ssh:<target>`, and its workspace is keyed on the environment.
 */
export function resolveReclaimedEphemeralVmWorkspaceHostId(
  event: EphemeralVmReclaimMatchInput,
  state: WorktreeOperationRouteState
): ExecutionHostId | null {
  const workspaceId = event.workspaceId
  if (!workspaceId) {
    return null
  }
  const candidates = getWorktreeOperationOwnerHostIds(state, workspaceId).filter((hostId) =>
    event.hostIds.includes(hostId)
  )
  if (candidates.length === 0) {
    return null
  }
  return (
    candidates.find((hostId) => parseExecutionHostId(hostId)?.kind === 'runtime') ?? candidates[0]
  )
}

/**
 * Forget the workspace rows of a host main has already reclaimed.
 *
 * Why `forget-local`: the machine that held the files is gone, so clearing Orca's own records is the
 * only removal available — that mode is defined as exactly that, and touches no git or remote state.
 */
export async function forgetReclaimedEphemeralVmWorkspace(
  event: EphemeralVmReclaimMatchInput,
  store: EphemeralVmReclaimStore = useAppStore
): Promise<void> {
  const workspaceId = event.workspaceId
  if (!workspaceId) {
    return
  }
  const state = store.getState()
  if (getWorktreeOperationOwnerHostIds(state, workspaceId).length === 0) {
    // Why silent: this renderer lists no row for the workspace, so Orca's list has nothing to drop.
    return
  }
  const hostId = resolveReclaimedEphemeralVmWorkspaceHostId(event, state)
  if (!hostId) {
    console.warn(
      `Not forgetting reclaimed workspace ${workspaceId}: none of its rows belong to the reclaimed host.`
    )
    return
  }
  const result = await store
    .getState()
    .removeWorktree({ id: workspaceId, executionHostId: hostId }, false, { mode: 'forget-local' })
  if (!result.ok) {
    console.warn(`Could not forget reclaimed workspace ${workspaceId}: ${result.error}`)
  }
}

/**
 * Forget the rows of runtimes main has already reclaimed but could not announce.
 *
 * Why this exists: the reclaim event is a one-shot broadcast. A reclaim that happens while the main
 * window is closed (macOS keeps the app alive) is lost, and the record is marked reclaimed, so the
 * rows would otherwise stay in the sidebar until the user removed them by hand.
 */
export async function reconcileReclaimedEphemeralVmWorkspaces(
  store: EphemeralVmReclaimStore = useAppStore
): Promise<void> {
  const api = window.api?.ephemeralVm
  if (!api?.listRuntimes) {
    return
  }
  let runtimes: EphemeralVmRuntimeRecord[]
  try {
    const answer = await api.listRuntimes()
    // Why the guard: this runs on start from a fire-and-forget caller, so a stub or an older
    // bridge answering anything but a list must read as "nothing to reconcile", not as an
    // unhandled rejection in the middle of an unrelated test run.
    runtimes = Array.isArray(answer) ? answer : []
  } catch {
    return
  }
  for (const runtime of runtimes) {
    // Why the persisted ids rather than the live record's: the reclaim cleared `sshTargetId` and
    // `runtimeEnvironmentId`, so an SSH-only host would otherwise have no identity to match on.
    const hostIds = runtime.reclaimedHostIds ?? []
    if (runtime.reclaimedAt === undefined || !runtime.workspaceId || hostIds.length === 0) {
      continue
    }
    await forgetReclaimedEphemeralVmWorkspace(
      { workspaceId: runtime.workspaceId, hostIds },
      store
    ).catch((error: unknown) => {
      // Why non-fatal: one unreconcilable row must not strand the rest.
      console.warn('Failed to forget a reclaimed ephemeral host workspace on start:', error)
    })
  }
}
export function registerEphemeralVmReclaimIpcBridge(unsubs: (() => void)[]): void {
  const api = window.api?.ephemeralVm
  // Why also on every publish: a reclaim that fired while no window was open had nobody to tell, and
  // the registration-time pass may run before this renderer has loaded any workspace rows. Re-running
  // when the records are refreshed is what makes those rows converge once the lists are there.
  unsubs.push(onEphemeralVmRuntimesPublished(() => void reconcileReclaimedEphemeralVmWorkspaces()))
  void reconcileReclaimedEphemeralVmWorkspaces()
  if (!api?.onRuntimeReclaimed) {
    return
  }
  unsubs.push(
    api.onRuntimeReclaimed((event) => {
      void (async () => {
        try {
          await forgetReclaimedEphemeralVmWorkspace(event)
        } catch (error) {
          // Why non-fatal: a workspace that cannot be forgotten must not strand later events.
          console.warn('Failed to forget a reclaimed ephemeral host workspace:', error)
        } finally {
          // Main's records moved with the reclaim, so every lease surface has to re-read them.
          await refreshEphemeralVmRuntimes()
        }
      })()
    })
  )
}
