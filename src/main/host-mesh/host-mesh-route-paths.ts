import { HOST_MESH_MAX_ENDPOINT_CANDIDATES } from '../../shared/host-mesh/host-mesh-contract'
import { isDialableEndpoint } from '../../shared/host-mesh/host-mesh-routes'
import { preferredEndpoint } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { sendRemoteRuntimeRequestOnSocket } from '../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { isTailnetIPv4Address } from '../../shared/network/tailnet-address'
import {
  resolveEnvironment,
  resolveEnvironmentPairingOffer,
  updateEnvironmentFromPairingCode
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { resolveAdvertisedPairingEndpoint } from '../runtime/rpc/server/pairing/network/pairing-endpoint'
import { getPairingNetworkInterfaces } from '../runtime/rpc/server/pairing/network/pairing-network-interfaces'
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
 * This host's own endpoints, best first: every path a member could dial it on right now.
 *
 * Why the interface table and not the pairing's own endpoint: that endpoint names the single address the pair was
 * made on, so a member that loses it has nothing left to try. LAN addresses come before tailnet ones because the
 * directly-attached path is the one that works without an overlay being up.
 */
export async function ownEndpoints(server: HostMeshRuntimeServer): Promise<string[]> {
  const bound = server.getWebSocketEndpoint()
  if (bound === null) {
    return []
  }
  const interfaces = await getPairingNetworkInterfaces(server.getNetworkExposureBindHost())
  const ranked = [...interfaces].sort(
    (left, right) =>
      Number(isTailnetIPv4Address(left.address)) - Number(isTailnetIPv4Address(right.address))
  )
  const endpoints: string[] = []
  for (const iface of ranked) {
    const resolved = resolveAdvertisedPairingEndpoint(bound, iface.address)
    if (!resolved.ok || endpoints.includes(resolved.endpoint)) {
      continue
    }
    endpoints.push(resolved.endpoint)
    if (endpoints.length >= HOST_MESH_MAX_ENDPOINT_CANDIDATES) {
      break
    }
  }
  return endpoints
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

/** Whether this host answers on a candidate path, authenticated with the pairing's own credential. */
async function endpointAnswers(
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
 * Points this host's pairing for a member at the endpoint that answered, so every feature dials the live path.
 *
 * Why the store row and not a private cache: host-sync, the host graph and any paired client resolve the endpoint
 * from this row on each call, so rewriting it is what heals them — none of them needs to learn about routes.
 *
 * Why the rewrite goes through the store's worker: a pairing row is a synchronous file write, and this runs inside a
 * pass that must not stall the main process. Why the code is rebuilt from the offer this host already holds: the
 * credential is unchanged, so the machine on the other end stays the same host and only its address moves.
 *
 * Why a tunnel is refused: its endpoint is a local port that tunnel owns, and rewriting it would point the row at an
 * address nothing serves.
 */
async function adoptEnvironmentEndpoint(
  userDataPath: string,
  environmentId: string,
  endpoint: string
): Promise<boolean> {
  try {
    const environment = await resolveEnvironment(userDataPath, environmentId)
    if (environment.connectionDependency === 'ssh-tunnel') {
      return false
    }
    if (preferredEndpoint(environment).endpoint === endpoint) {
      return true
    }
    const offer = await resolveEnvironmentPairingOffer(userDataPath, environmentId)
    await updateEnvironmentFromPairingCode(userDataPath, environmentId, {
      pairingCode: encodePairingOffer({ ...offer, endpoint })
    })
    return true
  } catch {
    return false
  }
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
  const current = await environmentEndpoint(userDataPath, args.environmentId)
  for (const candidate of args.candidates) {
    if (candidate === current || !isDialableEndpoint(candidate)) {
      continue
    }
    if (!(await endpointAnswers(userDataPath, args.environmentId, candidate))) {
      continue
    }
    if (await adoptEnvironmentEndpoint(userDataPath, args.environmentId, candidate)) {
      return candidate
    }
  }
  return null
}
