import { useCallback, useEffect, useRef, useState } from 'react'
import { useNow } from '@/lib/window-activity/use-now'
import type { HostMeshSettings } from '../../../../../../shared/host-mesh/host-mesh-admission'
import type { HostMeshApi, HostMeshSnapshot } from '../../../../../../preload/api/host-mesh-api'
import { publishHostMeshSnapshot } from './host-mesh-shared-state'

export type HostGroupBusy = 'remove' | 'leave' | 'settings'

/** Why a code and not a sentence: the hook stays independent of the UI language, so a language change cannot refetch. */
export type HostGroupFailure = 'unavailable' | 'invalid-request' | 'action-failed'

export type HostGroupSnapshotState = {
  available: boolean
  snapshot: HostMeshSnapshot | null
  busy: HostGroupBusy | null
  failure: HostGroupFailure | null
  removeMember: (hostKey: string) => Promise<void>
  leave: () => Promise<void>
  updateSettings: (patch: Partial<HostMeshSettings>) => Promise<void>
}

/**
 * How often an open pane re-reads what the main process has already reconciled.
 *
 * Why this is a read and not a sync: the pass runs in the main process on its own cadence, so an open pane only has
 * to look at the result — a local read, no network, and nothing a closed pane pays for.
 */
const REREAD_MS = 15_000

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** Why module level: the compiler cannot inline a `try`/`finally` in a component, and a bailout is a rerender cost. */
async function attempt<T>(task: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await task() }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * The mesh, as the pane reads it: once on mount, then whenever the shared clock ticks and after every action.
 *
 * Why every result is published: the switch, the summary and every host row's badge read one shared snapshot, and a
 * read that stayed inside this hook would leave the whole pane showing whatever the fixture last put there — in the
 * app, nothing at all.
 *
 * Why there is no Sync action: the main process reconciles at startup, every minute and on every connection change,
 * so a button would ask for something already happening — and a screen that offers it implies the automatic path
 * does not exist.
 */
export function useHostGroupSnapshot(): HostGroupSnapshotState {
  const [snapshot, setSnapshot] = useState<HostMeshSnapshot | null>(null)
  // Why a re-read is not `busy`: a background read every 15s would disable the switch and every Eject under the
  // owner's pointer, and would clear an action's error message while they were reading it.
  const [busy, setBusy] = useState<HostGroupBusy | null>(null)
  const [failure, setFailure] = useState<HostGroupFailure | null>(null)
  const mountedRef = useRef(true)
  // Why a sequence: a 15s read that started before an Eject can resolve after it, and publishing that older snapshot
  // would put the ejected member back on screen until the next read. An action is the newer fact, so it wins.
  const actionSeqRef = useRef(0)
  const nowMs = useNow(REREAD_MS)

  const read = useCallback(async () => {
    const api = window.api?.hostMesh
    if (!api) {
      setFailure('unavailable')
      return
    }
    const seqAtStart = actionSeqRef.current
    const result = await attempt(() => api.read())
    if (!mountedRef.current || actionSeqRef.current !== seqAtStart) {
      return
    }
    if (result.ok) {
      publishHostMeshSnapshot(result.value)
      setSnapshot(result.value)
    } else {
      setFailure(describeHostGroupFailure(result.error))
    }
  }, [])

  const act = useCallback(
    async (kind: HostGroupBusy, call: (api: HostMeshApi) => Promise<HostMeshSnapshot>) => {
      const api = window.api?.hostMesh
      if (!api) {
        setFailure('unavailable')
        return
      }
      setBusy(kind)
      setFailure(null)
      const result = await attempt(() => call(api))
      if (!mountedRef.current) {
        return
      }
      actionSeqRef.current += 1
      setBusy(null)
      if (result.ok) {
        publishHostMeshSnapshot(result.value)
        setSnapshot(result.value)
      } else {
        setFailure(describeHostGroupFailure(result.error))
      }
    },
    []
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Why keyed on the clock: the same effect covers the first read and every later one, so a pane left open follows
  // the passes the main process is running rather than showing the state it mounted with.
  useEffect(() => {
    void read()
  }, [read, nowMs])

  const removeMember = useCallback(
    (hostKey: string) => act('remove', (api) => api.remove(hostKey)),
    [act]
  )
  const leave = useCallback(() => act('leave', (api) => api.leave()), [act])
  const updateSettings = useCallback(
    (patch: Partial<HostMeshSettings>) => act('settings', (api) => api.settings(patch)),
    [act]
  )

  return {
    available: Boolean(window.api?.hostMesh),
    snapshot,
    busy,
    failure,
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
