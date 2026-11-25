import { useCallback, useEffect, useRef, useState } from 'react'
import { HOST_GRAPH_NODE_TTL_MS } from '../../../../../shared/host-graph/host-graph-contract'
import type { HostGraphSnapshot } from '../../../../../shared/host-graph/host-graph-snapshot'

/**
 * The machines this client can see but is not paired with.
 *
 * Why `distance > 1` is the test: `composeHostGraph` gives a node this client is directly paired with a
 * distance of 1, so anything further only exists because a peer reported it. Those are the rows the
 * status bar could not show before.
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

const EMPTY: RelayedFleet = {
  relayed: [],
  unavailablePeerCount: 0,
  unsupportedPeerCount: 0,
  refresh: () => undefined
}

export function useRelayedFleetHosts(): RelayedFleet {
  const [fleet, setFleet] = useState<RelayedFleetHost[]>([])
  const [failures, setFailures] = useState<{ unavailable: number; unsupported: number }>({
    unavailable: 0,
    unsupported: 0
  })
  const mountedRef = useRef(true)
  const inFlightRef = useRef(false)

  const load = useCallback(async () => {
    const api = window.api?.hostGraph
    if (!api || inFlightRef.current) {
      return
    }
    inFlightRef.current = true
    try {
      const snapshot: HostGraphSnapshot = await api.read()
      if (!mountedRef.current) {
        return
      }
      setFleet(relayedHostsOf(snapshot, Date.now()))
      setFailures({
        unavailable: snapshot.failures.filter(
          (failure) => failure.code !== 'capability_unsupported'
        ).length,
        unsupported: snapshot.failures.filter(
          (failure) => failure.code === 'capability_unsupported'
        ).length
      })
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
    return () => {
      mountedRef.current = false
    }
  }, [load])

  return fleet.length === 0 && failures.unavailable === 0 && failures.unsupported === 0
    ? { ...EMPTY, refresh: () => void load() }
    : {
        relayed: fleet,
        unavailablePeerCount: failures.unavailable,
        unsupportedPeerCount: failures.unsupported,
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
