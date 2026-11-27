import { HOST_MESH_MAX_ENDPOINT_CANDIDATES } from '../../shared/host-mesh/host-mesh-contract'
import { isDialableEndpoint } from '../../shared/host-mesh/host-mesh-routes'
import type { KnownRuntimeEnvironment } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import { preferredEndpoint } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import { pairedRuntimeConnectionFromOffer } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { sendRemoteRuntimeRequestOnSocket } from '../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { isTailnetIPv4Address } from '../../shared/network/tailnet-address'
import {
  resolveEnvironment,
  resolveEnvironmentPairingOffer
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { resolveAdvertisedPairingEndpoint } from '../runtime/rpc/server/pairing/network/pairing-endpoint'
import { getPairingNetworkInterfaces } from '../runtime/rpc/server/pairing/network/pairing-network-interfaces'
import { relocatePairingEndpoint } from './host-mesh-pairing-endpoint'
import type { HostMeshRuntimeServer } from './host-mesh-runtime-deps'

/**
 * The paths a member can be reached on, and what to do when the one a pairing names stops answering.
 *
 * Why this is its own module: it is the only place that probes a network and rewrites a pairing row, and both are
 * things a reader wants to see together rather than between the mesh's mints and revokes.
 */

/**
 * How long one candidate path may take to answer before it is treated as a network this host is not on.
 *
 * Why much shorter than a call: a candidate is a guess about a network, and four guesses at the full call timeout
 * would spend longer than a pass has. A path that cannot complete a status read in this window is not the one.
 */
const PROBE_TIMEOUT_MS = 4_000

/**
 * How long an interface table is reused.
 *
 * Why cached at all: this is read on every inbound sync reply as well as every pass, and on a Windows host with WSL
 * that table costs a PowerShell start. Interface addresses do not change often enough for a call to need a fresh one.
 */
const INTERFACES_TTL_MS = 30_000

type RouteInterface = Awaited<ReturnType<typeof getPairingNetworkInterfaces>>[number]

let interfacesCache: { bindHost: string; at: number; value: RouteInterface[] } | null = null

async function readInterfaces(server: HostMeshRuntimeServer): Promise<RouteInterface[]> {
  const bindHost = server.getNetworkExposureBindHost()
  const now = Date.now()
  if (
    interfacesCache !== null &&
    interfacesCache.bindHost === bindHost &&
    now - interfacesCache.at < INTERFACES_TTL_MS
  ) {
    return interfacesCache.value
  }
  const value = await getPairingNetworkInterfaces(bindHost)
  interfacesCache = { bindHost, at: now, value }
  return value
}

/**
 * This host's own endpoints, best first: every path a member could dial it on right now.
 *
 * Why the interface table and not the pairing's own endpoint: that endpoint names the single address the pair was
 * made on, so a member that loses it has nothing left to try. LAN addresses come before tailnet ones because the
 * directly-attached path is the one that works without an overlay being up.
 *
 * Why one tailnet slot is reserved: a machine with four bridge or docker adapters would otherwise spend the whole
 * cap on addresses no other machine can reach, and the overlay is the path that works across networks.
 */
export async function ownEndpoints(server: HostMeshRuntimeServer): Promise<string[]> {
  const bound = server.getWebSocketEndpoint()
  if (bound === null) {
    return []
  }
  const interfaces = await readInterfaces(server)
  const resolved: { endpoint: string; tailnet: boolean }[] = []
  for (const iface of interfaces) {
    const advertised = resolveAdvertisedPairingEndpoint(bound, iface.address)
    if (!advertised.ok || resolved.some((entry) => entry.endpoint === advertised.endpoint)) {
      continue
    }
    resolved.push({ endpoint: advertised.endpoint, tailnet: isTailnetIPv4Address(iface.address) })
  }
  const direct = resolved.filter((entry) => !entry.tailnet).map((entry) => entry.endpoint)
  const tailnet = resolved.filter((entry) => entry.tailnet).map((entry) => entry.endpoint)
  const directLimit =
    tailnet.length === 0 ? HOST_MESH_MAX_ENDPOINT_CANDIDATES : HOST_MESH_MAX_ENDPOINT_CANDIDATES - 1
  return [...direct.slice(0, directLimit), ...tailnet].slice(0, HOST_MESH_MAX_ENDPOINT_CANDIDATES)
}

/** The endpoint this host's pairing row for a member currently dials, or null when there is no such row. */
async function environmentEndpoint(
  userDataPath: string,
  environmentId: string
): Promise<string | null> {
  try {
    return preferredEndpoint(await resolveEnvironment(userDataPath, environmentId)).endpoint
  } catch {
    return null
  }
}

/**
 * Whether this path answers as the host the pairing is with.
 *
 * Why the pairing's own credential: an address that answers without it is some other machine on the network, and
 * this is the only test that proves the path reaches the host the caller thinks it does. Exported so the boundary is
 * testable against a real socket that rejects the wrong credential.
 */
export async function probePairingEndpoint(
  userDataPath: string,
  environmentId: string,
  endpoint: string
): Promise<boolean> {
  try {
    const offer = await resolveEnvironmentPairingOffer(userDataPath, environmentId)
    const response = await sendRemoteRuntimeRequestOnSocket(
      pairedRuntimeConnectionFromOffer({ ...offer, endpoint }),
      'status.get',
      undefined,
      PROBE_TIMEOUT_MS
    )
    return response.ok
  } catch {
    return false
  }
}

/**
 * What a failed dial needs from the pairing row and from the network, injected so the order of checks is testable
 * without a store or a socket.
 */
export type RouteFailoverDeps = {
  /** The endpoint the row dials now, or null when there is no row to move. */
  current: () => Promise<string | null>
  /**
   * Whether the row's address is not its own to move: a tunnel endpoint is a local port the tunnel owns, and an
   * access link or a managed deployment pins the address its own schema requires.
   */
  isFixedEndpoint: () => Promise<boolean>
  probe: (endpoint: string) => Promise<boolean>
  /** Points the row at the new address, keeping its credential and its pairing revision. */
  relocate: (endpoint: string) => Promise<boolean>
}

/**
 * Tries each candidate in order and stops at the first one that answers as this host and can be adopted.
 *
 * Why a candidate that answers but cannot be adopted does not end the search: the row refusing the move is a fact
 * about that row (it is fixed), and a later candidate is no worse than an earlier one.
 */
export async function adoptFirstReachable(
  deps: RouteFailoverDeps,
  candidates: readonly string[]
): Promise<string | null> {
  // Why the guard comes before any probe: a row whose address is not its own to move (a tunnel's local port, an
  // access link's loopback, a managed deployment's) must not be rewritten even when a candidate answers — and for
  // those rows the rewrite is worse than no repair, because the schema that owns that address then rejects the row.
  if (await deps.isFixedEndpoint()) {
    return null
  }
  const current = await deps.current()
  for (const candidate of candidates) {
    if (candidate === current || !isDialableEndpoint(candidate)) {
      continue
    }
    if (!(await deps.probe(candidate))) {
      continue
    }
    if (await deps.relocate(candidate)) {
      return candidate
    }
  }
  return null
}

/** Why the row is left alone rather than moved: its address is not the thing that changed. */
function hasFixedEndpoint(environment: KnownRuntimeEnvironment): boolean {
  return (
    environment.connectionDependency === 'ssh-tunnel' ||
    environment.sshAccess !== undefined ||
    environment.orcadDeployment !== undefined
  )
}

/**
 * Tries a member's other known endpoints and adopts the one that answers.
 *
 * Why the pairing's own credential is used to probe: an address that answers without it is some other machine, and
 * this is the only test that proves the path reaches the host the caller thinks it does.
 */
export async function adoptReachableEndpoint(
  userDataPath: string,
  args: { environmentId: string; candidates: readonly string[] }
): Promise<string | null> {
  return adoptFirstReachable(
    {
      current: () => environmentEndpoint(userDataPath, args.environmentId),
      isFixedEndpoint: async () => {
        try {
          return hasFixedEndpoint(await resolveEnvironment(userDataPath, args.environmentId))
        } catch {
          return true
        }
      },
      probe: (endpoint) => probePairingEndpoint(userDataPath, args.environmentId, endpoint),
      relocate: async (endpoint) =>
        relocatePairingEndpoint({
          userDataPath,
          environmentId: args.environmentId,
          endpoint,
          now: Date.now()
        })
    },
    args.candidates
  )
}
