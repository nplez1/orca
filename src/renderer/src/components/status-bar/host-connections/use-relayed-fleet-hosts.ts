import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HOST_GRAPH_NODE_TTL_MS } from '../../../../../shared/host-graph/host-graph-contract'
import type { HostGraphSnapshot } from '../../../../../shared/host-graph/host-graph-snapshot'

/**
 * The machines this client can see but is not paired with.
 *
 * Why `distance > 1` is the test: `composeHostGraph` gives a node this client is paired with a distance
 * of 1, so anything further exists only because a peer reported it. Those are the rows the status bar
 * could not show before.
 */

export type RelayedFleetHost = {
  key: string
  label: string
  /** The machine the fact came through, for "via <name>". */
  via: string
  live: boolean
  staleMinutes: number
}

export type RelayedFleet = {
  relayed: RelayedFleetHost[]
  /** Paired hosts that answered nothing this round. */
  unavailablePeerCount: number
  /** Paired hosts on a build that cannot share its host list yet. */
  unsupportedPeerCount: number
  refresh: () => void
}

/** How often staleness is re-read from an unchanged snapshot, so a dead host stops counting as live. */
const TICK_MS = 60_000

export function useRelayedFleetHosts(): RelayedFleet {
  const [snapshot, setSnapshot] = useState<HostGraphSnapshot | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const mountedRef = useRef(true)
  const inFlightRef = useRef(false)

  const load = useCallback(async () => {
    const api = window.api?.hostGraph
    if (!api || inFlightRef.current) {
      return
    }
    inFlightRef.current = true
    try {
      const next: HostGraphSnapshot = await api.read()
      if (!mountedRef.current) {
        return
      }
      setSnapshot(next)
      setNowMs(Date.now())
    } catch {
      // Why silent: a fleet read that fails is a fleet this client cannot see, and the direct hosts it
      // does know about are still a correct answer.
    } finally {
      inFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void load()
    const tick = setInterval(() => setNowMs(Date.now()), TICK_MS)
    return () => {
      mountedRef.current = false
      clearInterval(tick)
    }
  }, [load])

  const relayed = useMemo(
    () => (snapshot ? relayedHostsOf(snapshot, nowMs) : []),
    [snapshot, nowMs]
  )
  const unavailablePeerCount =
    snapshot?.failures.filter((failure) => failure.code !== 'capability_unsupported').length ?? 0
  const unsupportedPeerCount =
    snapshot?.failures.filter((failure) => failure.code === 'capability_unsupported').length ?? 0

  return {
    relayed,
    unavailablePeerCount,
    unsupportedPeerCount,
    refresh: () => void load()
  }
}

export function relayedHostsOf(snapshot: HostGraphSnapshot, now: number): RelayedFleetHost[] {
  return snapshot.fleet.nodes
    .filter((node) => node.distance > 1)
    .map((node) => ({
      key: node.ref.orcaHostKey ?? node.ref.sshHostKeys?.[0] ?? node.label,
      label: node.label,
      via: node.via[0] ?? '',
      live: node.liveness === 'connected' && now - node.lastConfirmedAt <= HOST_GRAPH_NODE_TTL_MS,
      staleMinutes: Math.max(0, Math.floor((now - node.lastConfirmedAt) / 60_000))
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
}
