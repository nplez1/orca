import { HOST_MESH_MAX_ENDPOINT_CANDIDATES, type HostMeshState } from './host-mesh-contract'

/**
 * Where a member can be dialed, and which of those paths is worth trying next.
 *
 * Why routes are kept apart from the pairing row: that row holds the one endpoint the pair was made on, and nothing
 * in it can be updated by a machine that moved networks — its own report over a working path is the only evidence.
 */

/**
 * Whether an advertised endpoint is one this build would dial: a WebSocket URL with a host and no credentials.
 *
 * Why this is checked at all: routes arrive from a peer, and a value that is not an endpoint here would be a failed
 * dial recorded as an unreachable member, which is the wrong story to tell its row.
 */
export function isDialableEndpoint(value: string): boolean {
  if (value.length === 0 || value.length > 512) {
    return false
  }
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      url.hostname.length > 0 &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

/**
 * The routes to keep for a member after it reported where it is, newest first.
 *
 * Why merge instead of replace: a machine that turns its tailnet off reports only the LAN endpoint, and dropping the
 * tailnet one would lose the address a pass needs the moment the tailnet comes back.
 */
export function rememberRoutes(args: {
  previous?: readonly string[]
  reported?: readonly string[]
}): string[] {
  const previous = args.previous ?? []
  const reported = args.reported ?? []
  // Why a slot is reserved for an address only the fallback set still holds: a machine reporting a full set would
  // otherwise drop every address left behind, and that leftover is the one a failed dial has to try.
  const carried = previous.filter((endpoint) => !reported.includes(endpoint))
  const reserved = carried.length > 0 ? 1 : 0
  const seen = new Set<string>()
  const kept: string[] = []
  const collect = (endpoints: readonly string[], limit: number): void => {
    for (const endpoint of endpoints) {
      if (kept.length >= limit) {
        return
      }
      if (seen.has(endpoint) || !isDialableEndpoint(endpoint)) {
        continue
      }
      seen.add(endpoint)
      kept.push(endpoint)
    }
  }
  collect(reported, HOST_MESH_MAX_ENDPOINT_CANDIDATES - reserved)
  collect(previous, HOST_MESH_MAX_ENDPOINT_CANDIDATES)
  return kept
}

/**
 * Records where a member is reachable, keeping the addresses it has left behind as fallbacks.
 *
 * Why a set and not the newest single address: a machine that loses its tailnet address reports only the LAN one,
 * and the address it held before is what a pass that ran while it was still on the tailnet knows to try.
 */
export function setHostMeshRoutes(
  state: HostMeshState,
  args: { hostKey: string; endpoints: readonly string[] }
): HostMeshState {
  const previous = state.routes[args.hostKey]
  const endpoints = rememberRoutes({ previous, reported: args.endpoints })
  if (endpoints.length === 0) {
    return state
  }
  if (
    previous !== undefined &&
    previous.length === endpoints.length &&
    previous.every((endpoint, index) => endpoint === endpoints[index])
  ) {
    return state
  }
  return { ...state, routes: { ...state.routes, [args.hostKey]: endpoints } }
}

/**
 * The endpoints worth trying when the pairing's own endpoint stopped answering, in order.
 *
 * Why the current one is left out: the caller only asks after that dial failed, and dialing it again spends the
 * whole timeout to learn what it already knows.
 */
export function dialCandidates(args: {
  current: string | null
  routes: readonly string[] | undefined
}): string[] {
  const seen = new Set<string>()
  return (args.routes ?? []).filter((endpoint) => {
    if (endpoint === args.current || seen.has(endpoint) || !isDialableEndpoint(endpoint)) {
      return false
    }
    seen.add(endpoint)
    return true
  })
}
