import { useMemo, useSyncExternalStore } from 'react'
import {
  isEphemeralVmHostActionable,
  isReleasedEphemeralVmRuntime,
  type EphemeralVmRuntimeRecord
} from '../../../shared/ephemeral-vm-runtimes'
import {
  getEphemeralVmRemainingMs,
  isEphemeralVmLifetimeExpired,
  readEphemeralVmLifetime,
  type EphemeralVmLifetime
} from '../../../shared/ephemeral-vm-lifetime'

/**
 * One renderer-side cache of the ephemeral host records, so every surface that needs to know how
 * long a host has left reads the same answer instead of polling the main process independently.
 *
 * Why a module store rather than component state: the workspace card, the host picker, and the
 * settings pane all render the same records at once, and a per-component fetch would let them
 * disagree about a deadline during the seconds around it.
 */

export type EphemeralVmRuntimeLease = {
  runtime: EphemeralVmRuntimeRecord
  lifetime: EphemeralVmLifetime | null
  expired: boolean
  /** Negative once the deadline has passed. */
  remainingMs: number
}

let runtimes: EphemeralVmRuntimeRecord[] = []
let loadStarted = false
const listeners = new Set<() => void>()
const publishListeners = new Set<() => void>()

/**
 * Told every time the cache is replaced, so a surface that has work to do on a changed record —
 * reconciling a reclaim the renderer never heard about — runs when the records are actually fresh.
 */
export function onEphemeralVmRuntimesPublished(listener: () => void): () => void {
  publishListeners.add(listener)
  return () => {
    publishListeners.delete(listener)
  }
}

function publish(next: EphemeralVmRuntimeRecord[]): void {
  runtimes = next
  for (const listener of listeners) {
    listener()
  }
  for (const listener of publishListeners) {
    listener()
  }
}

export function refreshEphemeralVmRuntimes(): Promise<void> {
  const api = window.api?.ephemeralVm
  if (!api?.listRuntimes) {
    return Promise.resolve()
  }
  return api
    .listRuntimes()
    .then(publish)
    .catch(() => {
      // A failed read keeps the last known records rather than blanking every countdown on screen.
    })
}

/**
 * Re-read after anything that changes a runtime.
 *
 * Why callers must do this: the cache loads once, so a flow that provisions, adopts, resumes or
 * suspends a host has to say so — otherwise a new ephemeral workspace shows no lease chip and no
 * Extend action until the app reloads, which is the whole feature silently not appearing.
 */
export function refreshEphemeralVmRuntimesAfterMutation(): void {
  void refreshEphemeralVmRuntimes()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!loadStarted) {
    loadStarted = true
    void refreshEphemeralVmRuntimes()
  }
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): EphemeralVmRuntimeRecord[] {
  return runtimes
}

/** The cached ephemeral host records, loaded once and refreshed on demand. */
export function useEphemeralVmRuntimes(): EphemeralVmRuntimeRecord[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * The host-action predicates, defined in `shared` and re-exported here so every existing renderer
 * import keeps one spelling of "this host is gone" and "this host can still take an action".
 */
export { isEphemeralVmHostActionable, isReleasedEphemeralVmRuntime }

/**
 * A host is identified by the workspace it serves, not by its own id, because that is the pairing
 * every workspace-facing surface already has in hand.
 *
 * Known limitation: a workspace id can exist on two hosts at once (two VMs from one recipe with a
 * fixed `projectRoot`), and this picks the first live record because a sidebar card carries no host
 * identity to disambiguate on. Both cards would then show the same host's lease. The destructive
 * paths do not rely on this — the reclaim bridge matches on the reclaimed host's own identities —
 * so the cost of the ambiguity is a wrong countdown and a context-menu item run against the other
 * host, never a wrong deletion.
 */
export function findEphemeralVmRuntimeForWorkspace(
  records: readonly EphemeralVmRuntimeRecord[],
  workspaceId: string | undefined
): EphemeralVmRuntimeRecord | null {
  if (!workspaceId) {
    return null
  }
  const candidates = records.filter((record) => record.workspaceId === workspaceId)
  // Why a live record wins: a workspace id can be re-created, and the reclaimed host's tombstone
  // would otherwise shadow the new host's lease and hide its Extend action.
  return candidates.find((record) => !isReleasedEphemeralVmRuntime(record)) ?? candidates[0] ?? null
}

export function resolveEphemeralVmRuntimeLease(
  runtime: EphemeralVmRuntimeRecord | null,
  nowMs: number
): EphemeralVmRuntimeLease | null {
  if (!runtime) {
    return null
  }
  const read = readEphemeralVmLifetime(runtime.recipeResult.userData)
  // Why an unreadable deadline still resolves to "no lease": the four lifetime keys are validated
  // when the recipe result is read, and a bad one is reported as a warning there. Arriving here at
  // all means the record was written by a different build, so the countdown is simply unavailable.
  const lifetime = read.ok ? read.lifetime : null
  return {
    runtime,
    lifetime,
    expired: lifetime ? isEphemeralVmLifetimeExpired(lifetime, nowMs) : false,
    remainingMs: lifetime ? getEphemeralVmRemainingMs(lifetime, nowMs) : 0
  }
}

/** The lease for one workspace's host, or null when that workspace runs on a non-ephemeral host. */
export function useEphemeralVmWorkspaceLease(
  workspaceId: string | undefined,
  nowMs: number
): EphemeralVmRuntimeLease | null {
  const records = useEphemeralVmRuntimes()
  return useMemo(
    () =>
      resolveEphemeralVmRuntimeLease(
        findEphemeralVmRuntimeForWorkspace(records, workspaceId),
        nowMs
      ),
    [records, workspaceId, nowMs]
  )
}
