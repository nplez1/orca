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
/**
 * A machine that holds a credential into a peer hands over an offer of its OWN, so the peer can dial back.
 *
 * Why this direction exists at all: the side that paired by hand holds the credential and the other side holds
 * nothing, so a fleet paired the way this fork's own topology pairs it (the studio dials its work hosts) is
 * one-way in the store before the mesh ever sees it. Every other method here is a call the *callee* makes, and
 * a host with no environment cannot make one — so without this a spoke can never be told the group exists.
 */
export const HOST_MESH_OFFER_BACK_METHOD = 'hostMesh.offerBack'

/**
 * How often this host re-offers to a member that has not taken it up.
 *
 * Why this bounds the minting: an offer is a device row on this host, and one nobody redeems is a live credential
 * for a pairing that may never happen. So a mint happens at most once per member per interval, and a retry inside
 * the interval resends the box already minted rather than minting a second one.
 */
export const HOST_MESH_REVERSE_OFFER_RETRY_MS = 10 * 60_000
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
  /**
   * The member's X25519 public key, base64. Why it is relayed: a sealed box needs a recipient key, and
   * `hostKey` is a one-way digest of this value, so a member list without it cannot be sealed to. Absent
   * for a member this build has not learned the key for, which refuses sealing rather than guessing.
   */
  publicKeyB64?: string
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
 * One machine's name, as the whole mesh knows it.
 *
 * Why versioned: the name belongs to the group rather than to whichever machine typed it, so two owners can
 * rename the same host and the group has to converge on one of them instead of flapping per pass. The higher
 * version wins and equal versions break deterministically, so every host ends up on the same word.
 */
export type HostMeshName = {
  label: string
  version: number
}

/**
 * The highest version a name may carry.
 *
 * Why a cap: a member reports the version it holds, and a value near the float ceiling would leave `+1` unable to
 * outrank it — one peer could then decide a name forever.
 */
export const HOST_MESH_NAME_MAX_VERSION = 1_000_000

/**
 * The name the pairing store writes when nobody is present to type one.
 *
 * Why it is derived and not random: an offer carries the minter's host key, so both ends can agree that this
 * exact string is a placeholder — which is what lets a real name beat it without any version arithmetic.
 */
export function hostMeshPlaceholderName(hostKey: string): string {
  return `Mesh host ${hostKey.slice(0, 8)}`
}

/** True for the name a redemption invented, which any real name may overwrite. */
export function isHostMeshPlaceholderName(label: string, hostKey: string): boolean {
  return label === hostMeshPlaceholderName(hostKey)
}

/**
 * The name a machine reports for itself when nobody has renamed it — its own hostname.
 *
 * Why this is the lowest rank: two hosts can disagree about what a machine is called, and the word an owner typed
 * when pairing is a better answer than the word the machine chose for itself.
 */
export const HOST_MESH_NAME_DEFAULT_VERSION = 1

/** A name typed at pairing, which outranks the machine's own hostname. */
export const HOST_MESH_NAME_SEED_VERSION = 2

/**
 * The link this host owns to a member. Two records exist per pair, one each way, so a half-join is one
 * of them missing rather than an ambiguous single state.
 */
export type HostMeshOutboundLink =
  | { kind: 'ok' }
  | { kind: 'awaitingOffer'; requestedAtEpoch: number; expiresAt: number }
  | { kind: 'redeemFailed'; reason: string; attempts: number; retryAt: number }
  | { kind: 'unreachable'; since: number }
  /**
   * The machine answers, but not this: it is running a build that predates the group.
   *
   * Why this is not `unreachable`: during a staggered upgrade the other computer is perfectly reachable, and
   * reporting a network fault for it sends the owner looking in the wrong place. This says "update that one".
   */
  | { kind: 'unsupported'; since: number }

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
  /**
   * Names the group agreed on, keyed by host key — including this host's own key, which is how a rename reaches
   * the machine it names.
   *
   * Why it is not `HostMeshMember.label`: a member row only exists on hosts that know the machine, and a name has
   * to survive being relayed by a host that has never paired with it.
   */
  names: Record<string, HostMeshName>
  /**
   * Where each member was last reachable, keyed by host key, best first.
   *
   * Why this host has to remember it: the pairing row holds the one endpoint the pair was made on, and a machine
   * that moved networks cannot announce the new one over the path that stopped working. What a member publishes
   * in its own sync is the only evidence of where it is now, so this is what makes a pass able to find it again.
   */
  routes: Record<string, string[]>
}

/** What `hostMesh.sync` carries: the whole group's shape, so one member cannot hide another's removal. */
export type HostMeshSyncPayload = {
  version: typeof HOST_MESH_PAYLOAD_VERSION
  groupId: string
  epoch: number
  /** The sender's own host key and public key, so a caller can address a sealed box back to it. */
  selfKey: string
  publicKeyB64: string
  /** The sender's own view. Receivers union members and tombstones; they never replace their own. */
  members: HostMeshMember[]
  tombstones: HostMeshTombstone[]
  links: Record<string, HostMeshLinkMatrix>
  /**
   * Every name the sender knows, this host's own included.
   *
   * Why optional: a peer on a build that predates naming sends none, and an older peer ignores what it cannot read,
   * so a fleet mid-update keeps syncing instead of refusing each other.
   */
  names?: Record<string, HostMeshName>
  /**
   * Where the sender can be reached right now, best first, as full `ws://` endpoints.
   *
   * Why optional: a peer on a build before this one sends none, and a receiver keeps the routes it already had —
   * so a fleet mid-update keeps syncing instead of treating every member as a machine that moved.
   */
  endpoints?: string[]
}

/** Whether a pair is joined at both ends, at one, or not at all. */
export type HostMeshPairStatus = 'complete' | 'half' | 'missing' | 'needsUpdate'

export function hostMeshPairStatus(hostKey: string, links: HostMeshLinkMatrix): HostMeshPairStatus {
  const outbound = links.outbound[hostKey]
  const inbound = links.inbound[hostKey] ?? { kind: 'absent' }
  // Asked before `half`: a machine that cannot answer is not a pair this host can finish repairing itself.
  if (outbound?.kind === 'unsupported') {
    return 'needsUpdate'
  }
  const outboundOk = outbound?.kind === 'ok'
  const inboundOk = inbound.kind === 'active'
  if (outboundOk && inboundOk) {
    return 'complete'
  }
  return outboundOk || inboundOk ? 'half' : 'missing'
}

/**
 * `hostMesh.join`: a newcomer asks one member to admit it, and hands over its own sealed offer.
 *
 * Why the joiner carries its own offer rather than asking for one: an offer this host mints is
 * `pairing-admin`, and a peer must never be able to make this host widen itself. The joiner mints for
 * itself, the member redeems, and the credential lands on the side that chose to hand it out.
 */
export type HostMeshJoinRequest = {
  version: typeof HOST_MESH_PAYLOAD_VERSION
  groupId: string
  epoch: number
  joiner: { hostKey: string; label: string; publicKeyB64: string }
  /** Minted by the joiner, addressed to the member receiving this request. */
  sealedForIntroducer: HostMeshSealedOffer
}

export type HostMeshJoinReply =
  | {
      kind: 'joined'
      groupId: string
      epoch: number
      /** Members and tombstones only; endpoint addresses are never relayed third-hand. */
      members: HostMeshMember[]
      tombstones: HostMeshTombstone[]
      /**
       * The introducer's own offer, minted now and addressed to the joiner — without it the joiner would
       * hold nothing for the host that just admitted it, which is the half-join this feature exists to avoid.
       */
      sealedForJoiner: HostMeshSealedOffer | null
    }
  | { kind: 'refused'; reason: string }

/** One sealed offer per member the joiner still needs, so the relay is a single batch. */
export type HostMeshRelayRequest = {
  version: typeof HOST_MESH_PAYLOAD_VERSION
  groupId: string
  epoch: number
  joiner: { hostKey: string; label: string; publicKeyB64?: string }
  sealed: HostMeshSealedOffer[]
}

export type HostMeshIntroduceRequest = {
  version: typeof HOST_MESH_PAYLOAD_VERSION
  groupId: string
  epoch: number
  /** The member doing the introducing, as it claims to be. Attribution, not the security boundary. */
  introducerHostKey: string
  newcomer: { hostKey: string; label: string; publicKeyB64?: string }
  /** The newcomer's offer, addressed to this recipient. */
  sealedForRecipient: HostMeshSealedOffer
}

export type HostMeshIntroduceReply =
  | { kind: 'accepted'; sealedForNewcomer: HostMeshSealedOffer | null }
  | { kind: 'refused'; reason: string }

/**
 * Why a newcomer polls for its own boxes instead of the member pushing them: the member knows the
 * newcomer's key but not when it is listening, and a poll is one call where a push is a dial from
 * whichever member happens to finish second.
 */
export type HostMeshPendingRequest = {
  version: typeof HOST_MESH_PAYLOAD_VERSION
  groupId: string
  hostKey: string
  /**
   * Where the sender can be dialed, on the sync as well as the reply.
   *
   * Why the request carries it: a pass only learns a member's addresses if the member answers, and the one pass a
   * member is most likely to fail is the one after it moved — so both directions have to publish.
   */
  endpoints?: string[]
}

export type HostMeshPendingReply = { sealed: HostMeshSealedOffer[] }

/**
 * `hostMesh.offerBack`: the machine holding the credential hands the other side an offer of its own.
 *
 * Why the offer is still the offerer's own: this method mints nothing on the recipient's behalf. It carries a
 * credential the offerer issued, addressed to a machine only that machine can open it with, which is the same
 * "nobody mints for another" rule the join follows from the other end.
 */
export type HostMeshOfferBackRequest = {
  version: typeof HOST_MESH_PAYLOAD_VERSION
  groupId: string
  epoch: number
  /** The machine offering, as it claims to be. The box is what binds the claim, not this field. */
  offerer: { hostKey: string; label: string; publicKeyB64: string }
  /** The offerer's own offer, sealed to the recipient. */
  sealed: HostMeshSealedOffer
}

export type HostMeshOfferBackReply =
  | { kind: 'accepted'; groupId: string; epoch: number }
  | { kind: 'refused'; reason: string }

export type HostMeshRemoveRequest = {
  version: typeof HOST_MESH_PAYLOAD_VERSION
  groupId: string
  hostKey: string
  removedBy: string
  epoch: number
}
