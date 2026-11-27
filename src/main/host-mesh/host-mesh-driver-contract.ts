import type {
  HostMeshIntroduceReply,
  HostMeshIntroduceRequest,
  HostMeshJoinReply,
  HostMeshJoinRequest,
  HostMeshOfferBackReply,
  HostMeshOfferBackRequest,
  HostMeshPairStatus,
  HostMeshPendingReply,
  HostMeshPendingRequest,
  HostMeshRelayRequest,
  HostMeshRemoveRequest,
  HostMeshState,
  HostMeshSyncPayload
} from '../../shared/host-mesh/host-mesh-contract'
import type { HostMeshSettings } from '../../shared/host-mesh/host-mesh-admission'
import type { HostMeshGroupSummary } from '../../shared/host-mesh/host-mesh-membership'

/**
 * The mesh's public surface, so the RPC layer, the IPC layer and the renderer can be written against one
 * shape while the transport underneath is still being built.
 *
 * Why every dependency is injected: the interesting behaviour — who is admitted, what a half-join looks
 * like, what happens when a member is asleep — is decided here, and it has to be checkable without
 * Electron, a home directory, a live peer or a clock.
 */

/** One member, as a surface renders it: the state plus how usable the link to it actually is. */
export type HostMeshMemberView = {
  hostKey: string
  label: string
  introducedBy?: string
  /** `complete` means both directions exist; `half` means one host believes it is paired and the other does not. */
  status: HostMeshPairStatus
  /** Null when this host holds no environment for the member, which is what a half-join looks like. */
  environmentId: string | null
}

export type HostMeshSnapshot = {
  inGroup: boolean
  groupId: string
  selfKey: string
  members: HostMeshMemberView[]
  summary: HostMeshGroupSummary
  settings: HostMeshSettings
  /** A line a surface can show verbatim when the last pass failed, or null. */
  lastError: string | null
  /**
   * When this launch last completed a pass, so a pane can say the mesh is being kept current rather than offering a
   * button for it. Null before the first pass of this launch finishes.
   */
  lastSyncedAt: number | null
  /**
   * How many members answered the last pass, or null before one ran.
   *
   * Why it is in the snapshot: every member failure is caught per member, so a pass against a sleeping fleet looks
   * exactly like a healthy one from the outside. This is what lets the scheduled pass see that it reached nobody
   * and slow down instead of dialling the same unreachable machines every minute forever.
   */
  lastPassReached: number | null
  /**
   * Where this group came from, when an upgrade created it from existing pairings.
   *
   * Why a surface needs it: the group appears without the owner asking for it, so the panel has to be able to
   * say what happened instead of presenting an unexplained group.
   */
  migration: { appliedAt: number; peerCount: number } | null
}

export type HostMeshJoinOutcome =
  | { kind: 'joined'; snapshot: HostMeshSnapshot; muted: string[] }
  | { kind: 'refused'; reason: string; snapshot: HostMeshSnapshot }

import type { HostMeshWriteLock } from './host-mesh-write-lock'

export type HostMeshDriverDeps = {
  userDataPath: string
  now: () => number
  /** One writer at a time over this host's store; shared by the driver and the peer-facing service. */
  lock?: HostMeshWriteLock
  /** This profile's own X25519 host keypair; the same one pairing and push authentication use. */
  ownKeypair: () => { publicKey: Uint8Array; secretKey: Uint8Array; publicKeyB64: string }
  /**
   * Mints a runtime offer on THIS host with no grants, so the newcomer gets `workspace` and nothing more.
   *
   * Why the recipient comes in: each one needs its OWN fresh device row. Upstream's offer registry reuses one
   * unused pending offer per (grants, creator), so minting twice in a pass would hand two machines the same
   * credential — one identity, and ejecting either one would cut the other's link for good.
   *
   * Why the device id comes back with it: minting creates the device row the redeemer will use, and that
   * row is the only thing removal can revoke. Discarding it leaves a removed member still able to run
   * commands here.
   */
  mintRuntimeOffer: (args: {
    environmentId: string
    recipientHostKey: string
  }) => Promise<{ offerUrl: string; deviceId: string; endpointCandidates: string[] }>
  /**
   * Revokes one device row this host minted, when the machine it was minted for did not take the offer.
   *
   * Why one row and not the member: the row that was just minted is a live, never-expiring credential the far side
   * may never redeem, and every retry mints another. A member that already holds a working credential from an earlier
   * pairing must keep it, so this names the row rather than the member.
   */
  revokeMintedRow: (deviceId: string) => void
  /**
   * Redeems an offer minted by a peer; returns what the store now holds for it.
   *
   * Why the expected key is an argument: an offer URL is what a peer supplied, so it must be checked against
   * the machine the caller believes minted it *before* this host saves an environment record for it.
   *
   * Why the label is too: this is the only moment the pairing gets a name, and the machine that made the
   * pairing knows what it is called — a name invented here is one the owner has to rename by hand.
   */
  redeemOffer: (offerUrl: string, expectedHostKey: string, label?: string) => Promise<RedeemedPeer>
  /** Cuts outbound reach to a member: the environment record, not the device row. */
  forgetEnvironment: (selector: string) => void
  /** Cuts inbound reach: the device row the member's credential belongs to. */
  forgetDevice: (hostKey: string) => void
  environmentIdForHostKey: (hostKey: string) => string | null
  /**
   * Renames this host's saved pairing for a machine, so the name the group agreed on is the name every surface
   * shows. Resolves true only when the row actually changed: a suffix the store chose never equals the group name,
   * and a rename that reported success every pass would rebroadcast the catalog every minute forever.
   *
   * Why it may disambiguate: two machines can legitimately answer to one name, and a row left on a placeholder
   * because the store refused the second `Mac mini` is worse than `Mac mini (2)`.
   */
  renameEnvironment?: (environmentId: string, name: string) => Promise<boolean>
  /**
   * Every machine this install is already paired with, which is the only thing an upgrade can group.
   *
   * Why the environment table rather than the group: the point of migration is to read the trust the owner
   * already declared, and on the first run of a new build the group is empty by definition.
   */
  listPairedHostKeys: () => { hostKey: string; label: string; publicKeyB64?: string }[]
  labelForHostKey: (hostKey: string) => string | null
  /**
   * What this machine calls itself when nobody has renamed it: its own hostname.
   *
   * Why a dependency: a recipient stores this string as the pairing's name, so the driver cannot invent `"this
   * host"` without every peer that redeemed an offer ending up with a row nobody can identify.
   */
  selfLabel?: () => string
  /** One call to a peer this host is paired with. Rejects only on transport failure. */
  send: <T>(environmentId: string, method: string, params: unknown) => Promise<T>
  /**
   * Where this host can be reached right now, best first, as endpoints a peer could dial.
   *
   * Why it is published to the group at all: the endpoint a pairing was made on is the only one a member has, and a
   * machine whose tailnet went away has no way to announce the LAN address that still works. Every pass hands the
   * set over, so the members that can still reach it learn where to look next time.
   */
  ownEndpoints: () => Promise<readonly string[]>
  /**
   * Tries a member's other known endpoints and adopts the one that answers.
   *
   * Why this lives behind a dependency: it rewrites the pairing row for that member, which is the one write that
   * makes every other feature able to reach it again — host-sync, the host graph and any paired client resolve the
   * endpoint from that row on each dial, so a repaired row heals them without each of them learning about routes.
   *
   * Resolves the endpoint now recorded for the member, or null when none of the candidates answered.
   */
  adoptReachableEndpoint?: (args: {
    environmentId: string
    candidates: readonly string[]
  }) => Promise<string | null>
  /**
   * Drops the connections this process pools for an environment, after its pairing row moved to a new address.
   *
   * Why it is a dependency: the pool lives in the catalog the renderer reads, and this module is a leaf. Without it a
   * repaired row is picked up by everything that resolves the row per call, while a long-lived socket keeps dialing
   * the address the row no longer names.
   */
  invalidateTransport?: (environmentId: string) => void
  /**
   * Revokes this host's own expired, never-redeemed runtime offers and returns the device ids it dropped.
   *
   * Why the pass does this: every reverse offer mints one runtime device row, so a member that never takes the
   * offer leaves one behind per retry. They expire on their own TTL and cannot pair anything, but Settings lists
   * them as active links until something removes them — an owner reading hundreds of them cannot tell a broken
   * mesh from a fleet that size.
   */
  pruneExpiredOffers?: () => readonly string[]
  /**
   * Asks this host to run a pass of its own, after a peer has just joined it.
   *
   * Why the receiving side needs it: a machine the studio dials never starts a sync, so the pairs between it and
   * the *other* members would wait for its owner to press a button. Nobody mints an offer on another's behalf, so
   * only its own pass can hand those offers over — and it has to happen here, because the peer that just paired it
   * cannot do it for it. Fired and not awaited: the caller is mid-request and owes that peer a prompt answer.
   */
  requestOwnSync?: () => void
  settings: () => HostMeshSettings
  saveSettings: (settings: HostMeshSettings) => void
}

/**
 * What the one-shot upgrade step did.
 *
 * `nothing-to-group` is a real outcome and not a failure: a machine with no pairings is a fresh install, and
 * it still records the run so pairing a machine later cannot be turned into a group it never asked for.
 */
export type HostMeshMigrationOutcome =
  | { kind: 'grouped'; peerCount: number }
  | { kind: 'nothing-to-group' }
  | { kind: 'already-recorded' }

export type RedeemedPeer = {
  environmentId: string
  hostKey: string
  label: string
  /**
   * True only when the redemption created the pairing row, which is the only case where this host chose its name.
   *
   * Why it matters: a row that already existed kept the name its owner typed, so treating that name as invented
   * would rank it below a hostname and let a later merge overwrite it.
   */
  namedHere: boolean
}

export type HostMeshDriver = {
  snapshot: () => Promise<HostMeshSnapshot>
  /** Adopt the group the given paired environment belongs to, and pair with every member of it. */
  join: (environmentId: string) => Promise<HostMeshJoinOutcome>
  /** Re-read every member: sync membership, collect offers addressed to us, retry abandoned links. */
  sync: () => Promise<HostMeshSnapshot>
  /** A member's connection came up, so an offer refused on technical grounds is worth making again. */
  noteConnectionChange: () => void
  removeMember: (hostKey: string) => Promise<HostMeshSnapshot>
  /** Renames a machine for the whole group; the name reaches the other hosts on their next pass. */
  renameMember: (hostKey: string, label: string) => Promise<HostMeshSnapshot>
  leave: () => Promise<HostMeshSnapshot>
  updateSettings: (patch: Partial<HostMeshSettings>) => Promise<HostMeshSnapshot>
  /** The one-shot upgrade step: group the machines this install was already paired with. */
  migrateFromPairings: () => HostMeshMigrationOutcome
}

/** The six methods a peer calls. Each one is a whole pass on the receiver's own store. */
export type HostMeshRpcService = {
  join: (params: HostMeshJoinRequest, caller: HostMeshCaller) => Promise<HostMeshJoinReply>
  relayIntroductions: (
    params: HostMeshRelayRequest,
    caller: HostMeshCaller
  ) => Promise<{
    forwarded: number
    refused: string[]
  }>
  introduce: (
    params: HostMeshIntroduceRequest,
    caller: HostMeshCaller
  ) => Promise<HostMeshIntroduceReply>
  pending: (params: HostMeshPendingRequest, caller: HostMeshCaller) => Promise<HostMeshPendingReply>
  /** A machine that already holds a credential here hands this host an offer of its own. */
  offerBack: (
    params: HostMeshOfferBackRequest,
    caller: HostMeshCaller
  ) => Promise<HostMeshOfferBackReply>
  sync: (params: HostMeshPendingRequest, caller: HostMeshCaller) => Promise<HostMeshSyncPayload>
  remove: (params: HostMeshRemoveRequest, caller: HostMeshCaller) => Promise<{ applied: boolean }>
}

/**
 * Who called.
 *
 * Why only a device id: the inbound RPC path knows the paired device and its fingerprint, and there is no
 * environment id or host key on it. So a caller's *claim* to be a particular member is attribution the UI
 * can show, never a trust anchor — what a member can actually cause is bounded by the sealed boxes it
 * carries, which only the newcomer's own key can have minted.
 */
export type HostMeshCaller = {
  pairedDeviceId?: string
  fingerprint?: string
}

export type HostMeshStateReader = () => HostMeshState
