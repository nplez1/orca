import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNow } from '@/lib/window-activity/use-now'
import type { HostMeshSnapshot } from '../../../../../preload/api/host-mesh-api'
import type { HostMeshPairStatus } from '../../../../../shared/host-mesh/host-mesh-contract'

/**
 * How joined each mesh member is, keyed by the paired runtime environment a host row already knows.
 *
 * Why keyed by environment rather than by host key: a status-bar row is an environment (or an SSH target),
 * and the mesh speaks in machine keys, so the translation happens here once instead of in every row.
 *
 * Why a read of its own instead of Settings' shared snapshot: that store exists to keep the switch, the
 * summary and the member rows of one screen agreeing. A closed Settings pane reads nothing, so a status bar
 * leaning on it would show no icons at all until someone opened Settings.
 */

/** How often an open menu re-reads what the main process has already reconciled; a closed one reads nothing. */
const REREAD_MS = 15_000

export type HostMeshPairStatuses = ReadonlyMap<string, HostMeshPairStatus>

export function useHostMeshPairStatuses(menuOpen: boolean): HostMeshPairStatuses {
  const [snapshot, setSnapshot] = useState<HostMeshSnapshot | null>(null)
  const mountedRef = useRef(true)
  const inFlightRef = useRef(false)
  // Why upstream's shared clock: it is visibility-gated, so a menu left open in a hidden window costs no timer.
  const nowMs = useNow(REREAD_MS, menuOpen)

  const load = useCallback(async () => {
    const api = window.api?.hostMesh
    if (!api || inFlightRef.current) {
      return
    }
    inFlightRef.current = true
    // Why a `catch` and not `try/finally`: a `finally` in a component body is one of the React compiler's bailouts,
    // so the flag is cleared on both paths here instead. Why silent about the failure: the mesh is a second fact
    // about a row that already renders its transport state, so a failed read leaves the glyph off rather than
    // turning a healthy host row into an error.
    const next = await api.read().catch(() => null)
    inFlightRef.current = false
    if (next !== null && mountedRef.current) {
      setSnapshot(next)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Why the clock as well as the flag: the main process reconciles on its own cadence, so a menu held open
  // follows it rather than showing the pairing state it opened with.
  useEffect(() => {
    if (menuOpen) {
      void load()
    }
  }, [load, menuOpen, nowMs])

  return useMemo(() => {
    const byEnvironmentId = new Map<string, HostMeshPairStatus>()
    for (const member of snapshot?.members ?? []) {
      // A member with no environment is one this computer holds no way into; it has no row to badge.
      if (member.environmentId !== null) {
        byEnvironmentId.set(member.environmentId, member.status)
      }
    }
    return byEnvironmentId
  }, [snapshot])
}
