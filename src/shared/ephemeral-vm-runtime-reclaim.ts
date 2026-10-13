import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'
import type { ExecutionHostId } from './execution-host'
import { readEphemeralVmLifetime, type EphemeralVmLifetime } from './ephemeral-vm-lifetime'

/**
 * How long past a provider deadline Orca waits before concluding the machine is not coming back.
 *
 * Why a grace at all: a provider that enforces its TTL lazily can leave a host reachable for a
 * short while after the stated deadline, while one that already deallocated it leaves the address
 * dead. Waiting costs nothing and stops Orca reclaiming a lease that was extended out of band.
 */
export const EPHEMERAL_VM_RECLAIM_GRACE_MS = 15 * 60_000

/** Why a runtime was, or was not, reclaimed. Each is a distinct, reportable reason. */
export type EphemeralVmReclaimDecline =
  /** The recipe published no provider deadline, so there is nothing to count down or reclaim on. */
  | 'no-provider-deadline'
  /** Already releasing or released — deciding again would race the attempt already running. */
  | 'already-reclaimed'
  /** Still inside the lease, or inside the grace that follows it. */
  | 'within-lease'
  /**
   * Past the deadline, but Orca holds no evidence the machine is gone. Loss of contact is never
   * evidence of absence: a host unreachable because this machine is off-network looks exactly like
   * one that was deallocated, and it may still be perfectly alive.
   */
  | 'host-may-return'

export type EphemeralVmReclaimVerdict =
  | { reclaim: false; reason: EphemeralVmReclaimDecline }
  | { reclaim: true; lifetime: EphemeralVmLifetime; reason: 'provider-lease-expired' }

/**
 * Pushed to the renderer when main reclaims a runtime, because dropping the host's registrations is
 * not enough — the workspace rows are the renderer's to forget, and only it knows how.
 */
export type EphemeralVmRuntimeReclaimed = {
  runtimeId: string
  repoId?: string
  /** The workspace that lived on the reclaimed host, so the renderer can forget it locally. */
  workspaceId?: string
  workspaceName?: string
  /** The provider deadline that passed, as the recipe reported it. */
  releaseAt: string
  /**
   * This host's own execution-host identities, never a bare workspace id.
   *
   * Why they travel with the event: one worktree id can exist on several hosts at once — two VMs
   * from the same recipe with a fixed `projectRoot` produce the same id — so a renderer that picked
   * any row with a matching id would forget a live sibling's row instead of this host's.
   */
  hostIds: ExecutionHostId[]
}

/**
 * The record fields the reclaim decision reads — narrowed so the decision can be exercised
 * without constructing a whole runtime record.
 */
export type EphemeralVmReclaimInput = Pick<
  EphemeralVmRuntimeRecord,
  'status' | 'cleanupStatus' | 'reclaimedAt' | 'recipeResult'
>

export function decideEphemeralVmRuntimeReclaim(args: {
  runtime: EphemeralVmReclaimInput
  nowMs: number
  /** Whether Orca's own connection to this host has permanently failed while online. */
  connectionExhausted: boolean
}): EphemeralVmReclaimVerdict {
  const { status, cleanupStatus, reclaimedAt } = args.runtime
  if (
    reclaimedAt !== undefined ||
    status === 'cleaned' ||
    status === 'cleanup_pending' ||
    cleanupStatus === 'succeeded'
  ) {
    return { reclaim: false, reason: 'already-reclaimed' }
  }
  const read = readEphemeralVmLifetime(args.runtime.recipeResult.userData)
  if (!read.ok || !read.lifetime) {
    return { reclaim: false, reason: 'no-provider-deadline' }
  }
  if (args.nowMs < read.lifetime.releaseAtMs + EPHEMERAL_VM_RECLAIM_GRACE_MS) {
    return { reclaim: false, reason: 'within-lease' }
  }
  if (!args.connectionExhausted) {
    return { reclaim: false, reason: 'host-may-return' }
  }
  return { reclaim: true, lifetime: read.lifetime, reason: 'provider-lease-expired' }
}
