import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostMeshSettings } from '../../../../../../shared/host-mesh/host-mesh-admission'
import type { HostMeshApi, HostMeshSnapshot } from '../../../../../../preload/api/host-mesh-api'

export type HostGroupBusy = 'read' | 'sync' | 'remove' | 'leave' | 'settings'

/** Why a code and not a sentence: the hook stays independent of the UI language, so a language change cannot refetch. */
export type HostGroupFailure = 'unavailable' | 'invalid-request' | 'action-failed'

export type HostGroupSnapshotState = {
  available: boolean
  snapshot: HostMeshSnapshot | null
  busy: HostGroupBusy | null
  failure: HostGroupFailure | null
  sync: () => Promise<void>
  removeMember: (hostKey: string) => Promise<void>
  leave: () => Promise<void>
  updateSettings: (patch: Partial<HostMeshSettings>) => Promise<void>
}

/**
 * The group, read once on mount and re-read only by an action.
 *
 * Why no polling: the group moves when this owner acts or when a member syncs, and a settings pane that
 * re-read on a timer would ask the same question on behalf of a screen nobody is watching.
 */
export function useHostGroupSnapshot(): HostGroupSnapshotState {
  const [snapshot, setSnapshot] = useState<HostMeshSnapshot | null>(null)
  const [busy, setBusy] = useState<HostGroupBusy | null>(null)
  const [failure, setFailure] = useState<HostGroupFailure | null>(null)
  const mountedRef = useRef(true)

  const run = useCallback(
    async (kind: HostGroupBusy, call: (api: HostMeshApi) => Promise<HostMeshSnapshot>) => {
      const api = window.api?.hostMesh
      if (!api) {
        setFailure('unavailable')
        return
      }
      setBusy(kind)
      setFailure(null)
      try {
        const next = await call(api)
        if (mountedRef.current) {
          setSnapshot(next)
        }
      } catch (error) {
        if (mountedRef.current) {
          setFailure(describeHostGroupFailure(error))
        }
      } finally {
        if (mountedRef.current) {
          setBusy(null)
        }
      }
    },
    []
  )

  useEffect(() => {
    mountedRef.current = true
    void run('read', (api) => api.read())
    return () => {
      mountedRef.current = false
    }
  }, [run])

  const sync = useCallback(() => run('sync', (api) => api.sync()), [run])
  const removeMember = useCallback(
    (hostKey: string) => run('remove', (api) => api.remove(hostKey)),
    [run]
  )
  const leave = useCallback(() => run('leave', (api) => api.leave()), [run])
  const updateSettings = useCallback(
    (patch: Partial<HostMeshSettings>) => run('settings', (api) => api.settings(patch)),
    [run]
  )

  return {
    available: Boolean(window.api?.hostMesh),
    snapshot,
    busy,
    failure,
    sync,
    removeMember,
    leave,
    updateSettings
  }
}

function describeHostGroupFailure(error: unknown): HostGroupFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('host_mesh_runtime_unavailable')) {
    return 'unavailable'
  }
  if (message.includes('host_mesh_invalid_request')) {
    return 'invalid-request'
  }
  return 'action-failed'
}
