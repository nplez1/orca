/**
 * The wire contract for host mesh groups.
 *
 * Why a group exists at all: Orca pairing is directional — the caller holds a `KnownRuntimeEnvironment`
 * for the callee — so a fully connected set of n machines needs n(n−1) records and n(n−1) user actions.
 * A group makes it n actions: joining one member introduces the newcomer to every other member, and each
 * host mints its own offers rather than acting on another's behalf.
 *
 * Why no host mints for another: `pairing.createOffer` is `pairing-admin`, which is owner-only by design.
 * Letting a paired desktop mint on a peer's behalf would make every pairing a grant to widen that peer's
 * access, which is the escalation `local/design/host-graph.md` §4 refuses. So the introducer only
 * *carries* an offer that the offer's own host minted and sealed to its recipient.
 */

export const HOST_MESH_RUNTIME_CAPABILITY = 'host.mesh.v1' as const

export const HOST_MESH_PAYLOAD_VERSION = 1

/** A newcomer tells one member it wants in, and hands over its own sealed offer. */
export const HOST_MESH_JOIN_METHOD = 'hostMesh.join'
/** A newcomer hands the introducer one sealed offer per existing member. */
export const HOST_MESH_RELAY_METHOD = 'hostMesh.relayIntroductions'
/** A member hands a peer a newcomer's sealed offer. */
export const HOST_MESH_INTRODUCE_METHOD = 'hostMesh.introduce'
/** Late answers: an offer minted for a newcomer that has not collected it yet. */
export const HOST_MESH_PENDING_METHOD = 'hostMesh.pending'
/** Members, tombstones and per-link state, so every host renders the same group. */
export const HOST_MESH_SYNC_METHOD = 'hostMesh.sync'
/** Removal and self-removal. */
export const HOST_MESH_REMOVE_METHOD = 'hostMesh.remove'

/**
 * Why 12: the cost is quadratic in links and the sidebar fans out `worktree.ps`/`repo.list` per member,
 * so the honest bound is what a person can actually run orcad on. A refused join names the cap.
 */
export const HOST_MESH_MAX_MEMBERS = 12

/** Introductions one member may forward per hour, so one host cannot enumerate the group at speed. */
export const HOST_MESH_MAX_INTRODUCTIONS_PER_HOUR = 4

/** An offer is unusable after this, matching the pairing offer's own window. */
export const HOST_MESH_OFFER_TTL_MS = 10 * 60_000

/** How many endpoint candidates one offer may carry, since one advertised address is often unreachable. */
export const HOST_MESH_MAX_ENDPOINT_CANDIDATES = 4

export const HOST_MESH_MAX_LABEL_CHARS = 256

/** The domain a sealed payload is prefixed with, so a box cannot be replayed as another kind of box. */
export const HOST_MESH_OFFER_DOMAIN = 'orca-mesh-offer/v1'

/** An offer sealed to exactly one machine. Only the recipient can open it, and only a host could make it. */
export type HostMeshSealedOffer = {
  version: typeof HOST_MESH_PAYLOAD_VERSION
  /** The machine this box is for; a box addressed elsewhere is refused rather than tried. */
  recipientHostKey: string
  /** The machine that minted it. */
  senderHostKey: string
  nonceB64: string
  ciphertextB64: string
}

/** What is inside a sealed offer. `offerUrl` is the ordinary pairing offer, unmodified. */
export type HostMeshOfferPayload = {
  version: typeof HOST_MESH_PAYLOAD_VERSION
  groupId: string
  epoch: number
  minterHostKey: string
  recipientHostKey: string
  /** The member that vouched for the recipient, so the row can say who introduced it. */
  introducedBy: string
  offerUrl: string
  /** Tried in order: one advertised address is often unreachable from a given peer. */
  endpointCandidates: string[]
  expiresAt: number
  /** Single-use marker; a second redemption of the same nonce is refused. */
  nonce: string
}

export type HostMeshMember = {
  hostKey: string
  label: string
  /** Absent for the host that created the group. */
  introducedBy?: string
  addedAtEpoch: number
}

/** A removal is a tombstone, so it outlives the member row it removes and blocks re-introduction. */
export type HostMeshTombstone = {
  hostKey: string
  epoch: number
  removedBy: string
}

/**
 * The link this host owns to a member. Two records exist per pair, one each way, so a half-join is one
 * of them missing rather than an ambiguous single state.
 */
export type HostMeshOutboundLink =
  | { kind: 'ok' }
  | { kind: 'awaitingOffer'; requestedAtEpoch: number; expiresAt: number }
  | { kind: 'redeemFailed'; reason: string; attempts: number; retryAt: number }
  | { kind: 'unreachable'; since: number }

/** The link a member owns back to this host, as that member last reported it. */
export type HostMeshInboundLink =
  | { kind: 'active' }
  | { kind: 'awaitingRedeem'; expiresAt: number }
  | { kind: 'absent' }

export type HostMeshLinkMatrix = {
  outbound: Record<string, HostMeshOutboundLink>
  inbound: Record<string, HostMeshInboundLink>
}

export type HostMeshState = {
  groupId: string
  epoch: number
  /** This host, which is never a member of its own list. */
  selfKey: string
  members: HostMeshMember[]
  tombstones: HostMeshTombstone[]
  links: HostMeshLinkMatrix
}

/** What `hostMesh.sync` carries: the whole group's shape, so one member cannot hide another's removal. */
export type HostMeshSyncPayload = {
  version: typeof HOST_MESH_PAYLOAD_VERSION
  groupId: string
  epoch: number
  /** The sender's own view. Receivers union members and tombstones; they never replace their own. */
  members: HostMeshMember[]
  tombstones: HostMeshTombstone[]
  links: Record<string, HostMeshLinkMatrix>
}

/** Whether a pair is joined at both ends, at one, or not at all. */
export type HostMeshPairStatus = 'complete' | 'half' | 'missing'

export function hostMeshPairStatus(hostKey: string, links: HostMeshLinkMatrix): HostMeshPairStatus {
  const outbound = links.outbound[hostKey]
  const inbound = links.inbound[hostKey] ?? { kind: 'absent' }
  const outboundOk = outbound?.kind === 'ok'
  const inboundOk = inbound.kind === 'active'
  if (outboundOk && inboundOk) {
    return 'complete'
  }
  return outboundOk || inboundOk ? 'half' : 'missing'
}
