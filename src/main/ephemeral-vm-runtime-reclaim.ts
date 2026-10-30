import type { BrowserWindow } from 'electron'
import {
  decideEphemeralVmRuntimeReclaim,
  type EphemeralVmRuntimeReclaimed
} from '../shared/ephemeral-vm-runtime-reclaim'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../shared/execution-host'
import type { ExecutionHostId } from '../shared/execution-host'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { isRuntimeHostContactRevoked } from '../shared/runtime-host-status'
import { releaseEphemeralVmRuntimeEnvironments } from './ephemeral-vm/runtime-environment-release'
import { clearRuntimeEnvironmentCapabilityEvidence } from './ipc/runtime-environments/runtime-environment-capability-evidence'
import { clearRuntimeEnvironmentManualDisconnect } from './ipc/runtime-environments/runtime-environment-manual-disconnect'
import { tryWithEphemeralVmRuntimeLock } from './ephemeral-vm-runtime-lock'
import { recordSwallowedFailure } from './observability/swallowed-failure'
import { removeRuntimeOwnedSshTarget } from './ephemeral-vm/runtime-ssh'
import { removeEphemeralVmRuntimeSshTarget } from './ephemeral-vm/runtime-ssh-cleanup'
import { getRuntimeEnvironmentStatusSnapshots } from './ipc/runtime-environments/runtime-environment-request-connections'
import { getSshConnectionManager } from './ssh/targets/ssh-target-registry'

/** Cadence of the reclaim sweep: a provider deadline is coarse, so a minute is prompt enough. */
export const EPHEMERAL_VM_RECLAIM_SWEEP_INTERVAL_MS = 60_000

export const EPHEMERAL_VM_RUNTIME_RECLAIMED_CHANNEL = 'ephemeralVm:runtimeReclaimed'

export type EphemeralVmRuntimeReclaimContext = {
  userDataPath: string
  /** Resolved at broadcast time: the window is replaced on macOS re-activation, so it must not be captured. */
  getMainWindow: () => BrowserWindow | null
  /** Injected by tests; production reads the wall clock. */
  now?: () => number
}

/**
 * Whether Orca holds enough evidence that this host is not coming back.
 *
 * The two transports answer differently, deliberately. An SSH target's reconnect ladder is bounded,
 * so it ends in `reconnection-failed` and that is the evidence. The shared-control scheduler caps
 * nothing — a roaming outage is unbounded there — so no exhausted-retry verdict exists, and the
 * strongest available evidence is a probe that actually failed, paired with a provider deadline
 * that has already passed (checked by the caller).
 *
 * `'checking'` is excluded because a probe that never completed is not a failure, and a lost
 * transport on SSH is excluded for the mirror-image reason. This is where the two transports stop
 * being symmetric, and it is a deliberate trade: a machine that is merely offline past its deadline
 * loses its rows even though it may still be alive. That costs a re-added workspace rather than any
 * work, because reclamation touches Orca's own records and never files, git state or branches.
 */
export function isEphemeralVmConnectionExhausted(runtime: EphemeralVmRuntimeRecord): boolean {
  if (runtime.sshTargetId) {
    return (
      getSshConnectionManager()?.getState(runtime.sshTargetId)?.status === 'reconnection-failed'
    )
  }
  if (runtime.runtimeEnvironmentId) {
    const snapshot = getRuntimeEnvironmentStatusSnapshots().find(
      (entry) => entry.environmentId === runtime.runtimeEnvironmentId
    )
    // `unavailable` is the failed probe; `isRuntimeHostContactRevoked` is the host's own verdict
    // that the pairing is over (refused us, or the user retired it).
    return Boolean(
      snapshot &&
      (isRuntimeHostContactRevoked({ snapshot }) || snapshot.verification === 'unavailable')
    )
  }
  return false
}

/**
 * Reclaims the local records of ephemeral hosts whose machine the provider has already taken away.
 *
 * Reclamation releases this host's registrations and tells the renderer to forget its workspace rows.
 * It deliberately does NOT run the recipe's `destroy`: the provider's own TTL owns the resource, and
 * the evidence available here is not strong enough to justify deleting a machine that may still be
 * alive with unpushed work on it. Destroy stays an explicit user action, and still runs when a
 * workspace is deleted.
 *
 * Why a sweep rather than an event: nothing tells Orca the moment a provider's TTL lapses, and the
 * host is unreachable by then, so the deadline is only knowable from the record. The interval stays
 * armed for as long as the app runs — unlike the retained-run reconciler it does not disarm when
 * empty, because "nothing pending" here means "no lease has lapsed yet", which is not the absence of
 * future work. It is unref'd, so it never holds the process alive.
 */
export class EphemeralVmRuntimeReclaimer {
  private context: EphemeralVmRuntimeReclaimContext
  private timer: ReturnType<typeof setInterval> | null = null
  private sweeping = false

  constructor(context: EphemeralVmRuntimeReclaimContext) {
    this.context = context
  }

  /** Re-registration can carry a new data path; the armed interval is reused, never stacked. */
  adoptContext(context: EphemeralVmRuntimeReclaimContext): void {
    this.context = context
  }

  start(): void {
    if (this.timer) {
      return
    }
    void this.sweep()
    const timer = setInterval(() => void this.sweep(), EPHEMERAL_VM_RECLAIM_SWEEP_INTERVAL_MS)
    timer.unref()
    this.timer = timer
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Reclaimed runtime ids, for tests and callers that want to report the pass. */
  async sweep(): Promise<string[]> {
    // Why: a release and its broadcast can outlive the interval, and two passes over one runtime
    // would race the reclaim already in flight.
    if (this.sweeping) {
      return []
    }
    this.sweeping = true
    const reclaimed: string[] = []
    try {
      const nowMs = this.nowMs()
      for (const { id } of listEphemeralVmRuntimes(this.context.userDataPath)) {
        try {
          if (await this.reclaim(id, nowMs)) {
            reclaimed.push(id)
          }
        } catch (error) {
          // Why: one unreadable runtime must not stop the others being reclaimed.
          recordSwallowedFailure('ephemeral-vm', error, `reclaim sweep failed for ${id}`)
        }
      }
    } catch (error) {
      // Why: the interval has no handler, so even failing to read the store must not become an
      // unhandled rejection.
      recordSwallowedFailure('ephemeral-vm', error, 'reclaim sweep could not read the runtimes')
    } finally {
      this.sweeping = false
    }
    return reclaimed
  }

  private async reclaim(runtimeId: string, nowMs: number): Promise<boolean> {
    const held = tryWithEphemeralVmRuntimeLock(runtimeId, () =>
      this.reclaimLocked(runtimeId, nowMs)
    )
    if (!held.ran) {
      // Why skip and not queue: the holder may be an extend hook waiting on a network that never
      // answers, and waiting for it here would leave `sweeping` true with no runtime reclaimed at all.
      console.warn(
        `[ephemeral-vm] Reclaim skipped ${runtimeId}: another lifecycle operation is in flight.`
      )
      return false
    }
    return held.promise
  }

  /**
   * The lock is held here, so the record is re-read rather than taken from the sweep's first pass:
   * the caller may have extended this lease while the sweep was working through the runtimes before
   * it, and deciding from that stale record would undo the extension they just paid for.
   */
  private async reclaimLocked(runtimeId: string, nowMs: number): Promise<boolean> {
    const runtime = listEphemeralVmRuntimes(this.context.userDataPath).find(
      (entry) => entry.id === runtimeId
    )
    if (!runtime) {
      return false
    }
    const verdict = decideEphemeralVmRuntimeReclaim({
      runtime,
      nowMs,
      connectionExhausted: isEphemeralVmConnectionExhausted(runtime)
    })
    if (!verdict.reclaim) {
      return false
    }
    // Why captured first: the reclaim clears the ids the identities derive from, and the renderer
    // needs them afterwards to match the workspace row.
    const hostIds = ephemeralVmRuntimeHostIds(runtime)
    // Why released before the record is updated: the release reads this record, and a failed release
    // that had already been unlinked would leave a server registration nothing points at. It reports
    // its own failures rather than throwing, so the record is still written either way.
    await this.releaseHostRegistrations(runtime)
    updateEphemeralVmRuntimeStatus(this.context.userDataPath, runtime.id, {
      reclaimedAt: nowMs,
      reclaimedHostIds: hostIds,
      // Why cleared, and not just the environment entry removed: this record asserting a connection
      // it no longer has is what let a later workspace removal match it and destroy the machine.
      connectionMode: null,
      runtimeEnvironmentId: null,
      updatedAt: nowMs
    })
    broadcastEphemeralVmRuntimeReclaimed(this.context.getMainWindow, {
      runtimeId: runtime.id,
      ...(runtime.repoId ? { repoId: runtime.repoId } : {}),
      ...(runtime.workspaceId ? { workspaceId: runtime.workspaceId } : {}),
      ...(runtime.workspaceName ? { workspaceName: runtime.workspaceName } : {}),
      releaseAt: verdict.lifetime.releaseAt,
      hostIds
    })
    return true
  }

  private nowMs(): number {
    return this.context.now?.() ?? Date.now()
  }

  private async releaseHostRegistrations(runtime: EphemeralVmRuntimeRecord): Promise<void> {
    try {
      await releaseEphemeralVmRuntimeEnvironments(
        this.context.userDataPath,
        runtime,
        // Why partial: this sweep holds no settings store, so the partition/listing retirement of a
        // Settings removal is out of reach here; the capability evidence and the stale manual
        // disconnect are the parts that would otherwise advertise a host the provider destroyed.
        (environmentId) => {
          clearRuntimeEnvironmentCapabilityEvidence(environmentId)
          clearRuntimeEnvironmentManualDisconnect(environmentId)
        }
      )
    } catch (error) {
      recordSwallowedFailure(
        'ephemeral-vm',
        error,
        "could not release the reclaimed host's servers"
      )
    }
    try {
      await removeEphemeralVmRuntimeSshTarget({
        userDataPath: this.context.userDataPath,
        runtime,
        removeTarget: removeRuntimeOwnedSshTarget
      })
    } catch (error) {
      recordSwallowedFailure('ephemeral-vm', error, 'could not remove the reclaimed host')
    }
  }
}

/** Every execution-host identity this runtime is reachable as, for the renderer to match on. */
function ephemeralVmRuntimeHostIds(runtime: EphemeralVmRuntimeRecord): ExecutionHostId[] {
  return [
    ...(runtime.runtimeEnvironmentId
      ? [toRuntimeExecutionHostId(runtime.runtimeEnvironmentId)]
      : []),
    ...(runtime.sshTargetId ? [toSshExecutionHostId(runtime.sshTargetId)] : [])
  ]
}

/** The workspace rows are the renderer's to forget, so the reclaim is announced, not just applied. */
function broadcastEphemeralVmRuntimeReclaimed(
  getMainWindow: () => BrowserWindow | null,
  payload: EphemeralVmRuntimeReclaimed
): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return
  }
  win.webContents.send(EPHEMERAL_VM_RUNTIME_RECLAIMED_CHANNEL, payload)
}

let activeReclaimer: EphemeralVmRuntimeReclaimer | null = null

/**
 * Idempotent: handler registration re-runs on macOS re-activation, and a second live interval would
 * sweep the store twice per minute. The context is refreshed rather than restarted for the same
 * reason — a restart would drop the interval the first registration armed.
 */
export function startEphemeralVmRuntimeReclaim(context: EphemeralVmRuntimeReclaimContext): void {
  if (activeReclaimer) {
    activeReclaimer.adoptContext(context)
    return
  }
  activeReclaimer = new EphemeralVmRuntimeReclaimer(context)
  activeReclaimer.start()
}

export function stopEphemeralVmRuntimeReclaim(): void {
  activeReclaimer?.stop()
  activeReclaimer = null
}
