import { useSyncExternalStore } from 'react'
import type { HostMeshApi, HostMeshSnapshot } from '../../../../../../preload/api/host-mesh-api'

/**
 * The group, as one snapshot every surface reads.
 *
 * Why shared rather than a hook per surface: the mesh moved into the host rows, so the switch, the summary and
 * every row's badge are three places reading one group on one screen. A read per surface would be the same
 * question asked once per row, and their answers could disagree — a row that still says "One-way" after the
 * eject that fixed it.
 */

let current: HostMeshSnapshot | null = null
const listeners = new Set<() => void>()

export function subscribeHostMeshSnapshot(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The snapshot itself, not a version counter: `useSyncExternalStore` compares this reference, so a read between
 * two publishes is stable and a publish always renders — which is what stops a row showing a state the switch
 * beside it has already left.
 */
export function getHostMeshSnapshot(): HostMeshSnapshot | null {
  return current
}

export function publishHostMeshSnapshot(next: HostMeshSnapshot | null): void {
  current = next
  for (const listener of listeners) {
    listener()
  }
}

/** Why every action answers with the whole group: the reply is both the write and the refresh. */
export async function runHostMeshAction(
  call: (api: HostMeshApi) => Promise<HostMeshSnapshot>
): Promise<HostMeshSnapshot> {
  const api = window.api?.hostMesh
  if (!api) {
    throw new Error('host_mesh_runtime_unavailable')
  }
  const next = await call(api)
  publishHostMeshSnapshot(next)
  return next
}

export function useHostMeshSnapshot(): HostMeshSnapshot | null {
  return useSyncExternalStore(subscribeHostMeshSnapshot, getHostMeshSnapshot, getHostMeshSnapshot)
}
