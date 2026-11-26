import type { HostGraphFleet } from './host-graph-compose'
import type { HostGraphAdjacency } from './host-graph-contract'

/**
 * What a client sees of the fleet after asking its peers.
 *
 * Why it lives in shared: the same object crosses IPC to the renderer, and the preload must type it
 * without importing main.
 */

/** Why a paired host contributed nothing. Everything else in the snapshot is still usable. */
export type HostGraphFailure = {
  environmentId: string
  name: string
  /**
   * `capability_unsupported` = that build does not answer the exchange, `peer_changed` = the saved
   * pairing is gone or now names another server, `host_unavailable` = everything else, including a
   * host the total deadline never reached.
   */
  code: 'host_unavailable' | 'capability_unsupported' | 'peer_changed'
}

export type HostGraphSnapshot = {
  /** This machine's own adjacency, as it was sent to every peer. */
  own: HostGraphAdjacency
  fleet: HostGraphFleet
  refreshedAt: number
  /** Paired hosts that answered nothing, so a short fleet is readable as a short fleet. */
  failures: HostGraphFailure[]
}
