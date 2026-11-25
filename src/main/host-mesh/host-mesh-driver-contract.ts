import type {
  HostMeshIntroduceReply,
  HostMeshIntroduceRequest,
  HostMeshJoinReply,
  HostMeshJoinRequest,
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

export type HostMeshDriverDeps = {
  userDataPath: string
  now: () => number
  /** This profile's own X25519 host keypair; the same one pairing and push authentication use. */
  ownKeypair: () => { publicKey: Uint8Array; secretKey: Uint8Array; publicKeyB64: string }
  /**
   * Mints a runtime offer on THIS host with no grants, so the newcomer gets `workspace` and nothing more.
   *
   * Why the device id comes back with it: minting creates the device row the redeemer will use, and that
   * row is the only thing removal can revoke. Discarding it leaves a removed member still able to run
   * commands here.
   */
  mintRuntimeOffer: () => Promise<{ offerUrl: string; deviceId: string }>
  /**
   * Redeems an offer minted by a peer; returns what the store now holds for it.
   *
   * Why the expected key is an argument: an offer URL is what a peer supplied, so it must be checked against
   * the machine the caller believes minted it *before* this host saves an environment record for it.
   */
  redeemOffer: (offerUrl: string, expectedHostKey: string) => Promise<RedeemedPeer>
  /** Cuts outbound reach to a member: the environment record, not the device row. */
  forgetEnvironment: (selector: string) => void
  /** Cuts inbound reach: the device row the member's credential belongs to. */
  forgetDevice: (hostKey: string) => void
  environmentIdForHostKey: (hostKey: string) => string | null
  /**
   * Every machine this install is already paired with, which is the only thing an upgrade can group.
   *
   * Why the environment table rather than the group: the point of migration is to read the trust the owner
   * already declared, and on the first run of a new build the group is empty by definition.
   */
  listPairedHostKeys: () => { hostKey: string; label: string }[]
  labelForHostKey: (hostKey: string) => string | null
  /** One call to a peer this host is paired with. Rejects only on transport failure. */
  send: <T>(environmentId: string, method: string, params: unknown) => Promise<T>
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
}

export type HostMeshDriver = {
  snapshot: () => Promise<HostMeshSnapshot>
  /** Adopt the group the given paired environment belongs to, and pair with every member of it. */
  join: (environmentId: string) => Promise<HostMeshJoinOutcome>
  /** Re-read every member: sync membership, collect offers addressed to us, retry abandoned links. */
  sync: () => Promise<HostMeshSnapshot>
  removeMember: (hostKey: string) => Promise<HostMeshSnapshot>
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
