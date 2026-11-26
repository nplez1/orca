import {
  HOST_MESH_MAX_INTRODUCTIONS_PER_HOUR,
  HOST_MESH_MAX_MEMBERS,
  type HostMeshOfferPayload,
  type HostMeshSealedOffer,
  type HostMeshState
} from './host-mesh-contract'

/**
 * Who may be admitted, decided as a pure function.
 *
 * Why separate from the transport and from the reducer: admission is the only place that decides whether a
 * machine gains a credential to this host, and the rules depend on settings, on membership, on tombstones
 * and on a rate limit at once. Kept here, each rule is one line with one reason and a test; inlined into an
 * RPC handler it would be untestable and unauditable.
 */

export type HostMeshSettings = {
  enabled: boolean
}

/**
 * Why on by default: the feature exists to make an already-paired fleet list the same workspaces everywhere, and a
 * default of off would leave every upgrade exactly as scattered as it was. The switch is how an owner says no.
 */
export const DEFAULT_HOST_MESH_SETTINGS: HostMeshSettings = {
  enabled: true
}

export type IntroduceRefusal =
  | 'no-group'
  | 'group-mismatch'
  | 'self-introduction'
  | 'introducer-not-member'
  | 'introductions-disabled'
  | 'tombstoned'
  | 'at-cap'
  | 'rate-limited'
  | 'offer-not-addressed-here'
  | 'offer-sender-mismatch'
  | 'offer-not-from-newcomer'
  | 'offer-not-vouched'
  | 'offer-expired'

export type IntroduceDecision =
  | { kind: 'accept'; payload: HostMeshOfferPayload }
  | { kind: 'refuse'; reason: IntroduceRefusal }

export type InboundIntroduce = {
  groupId: string
  introducerHostKey: string
  newcomer: { hostKey: string; label: string }
  /** `null` when the envelope did not open; the reason travels separately so this stays pure. */
  openedPayload: HostMeshOfferPayload | null
  openReason?: string
  /** Introductions this host has already admitted inside the current hour. */
  introductionsThisHour: number
  now: number
}

/**
 * The check order is the security argument, so it is deliberate:
 * membership first (is this even our group?), then the introducer's standing, then the tombstone, then the
 * cap, then the payload's own binding, then the rate limit, and only then consent. A refusal never depends
 * on a later, weaker check having passed.
 */
export function decideIntroduce(
  state: HostMeshState,
  settings: HostMeshSettings,
  invite: InboundIntroduce
): IntroduceDecision {
  if (state.groupId === '') {
    return { kind: 'refuse', reason: 'no-group' }
  }
  if (invite.groupId !== state.groupId) {
    return { kind: 'refuse', reason: 'group-mismatch' }
  }
  if (invite.newcomer.hostKey === state.selfKey) {
    return { kind: 'refuse', reason: 'self-introduction' }
  }
  if (!state.members.some((member) => member.hostKey === invite.introducerHostKey)) {
    return { kind: 'refuse', reason: 'introducer-not-member' }
  }
  if (!settings.enabled) {
    return { kind: 'refuse', reason: 'introductions-disabled' }
  }
  if (state.tombstones.some((tombstone) => tombstone.hostKey === invite.newcomer.hostKey)) {
    return { kind: 'refuse', reason: 'tombstoned' }
  }
  if (
    !state.members.some((member) => member.hostKey === invite.newcomer.hostKey) &&
    state.members.length >= HOST_MESH_MAX_MEMBERS
  ) {
    return { kind: 'refuse', reason: 'at-cap' }
  }
  const payload = invite.openedPayload
  if (payload === null) {
    // The envelope layer already refused it for a precise reason; membership cords must not widen that.
    return { kind: 'refuse', reason: mapOpenReason(invite.openReason) }
  }
  if (payload.recipientHostKey !== state.selfKey) {
    return { kind: 'refuse', reason: 'offer-not-addressed-here' }
  }
  // Why this is the splicing guard: an introducer can hand us a box from a machine it controls and call it
  // the newcomer. Requiring the box to come from the newcomer is what stops it naming a different one.
  if (payload.minterHostKey !== invite.newcomer.hostKey) {
    return { kind: 'refuse', reason: 'offer-not-from-newcomer' }
  }
  if (payload.introducedBy !== invite.introducerHostKey) {
    return { kind: 'refuse', reason: 'offer-not-vouched' }
  }
  if (payload.groupId !== state.groupId) {
    return { kind: 'refuse', reason: 'group-mismatch' }
  }
  if (payload.expiresAt <= invite.now) {
    return { kind: 'refuse', reason: 'offer-expired' }
  }
  if (invite.introductionsThisHour >= HOST_MESH_MAX_INTRODUCTIONS_PER_HOUR) {
    return { kind: 'refuse', reason: 'rate-limited' }
  }
  return { kind: 'accept', payload }
}

export type JoinRefusal =
  | 'joins-disabled'
  | 'joins-not-allowed'
  | 'tombstoned'
  | 'at-cap'
  | 'offer-not-addressed-here'
  | 'offer-not-from-joiner'
  | 'offer-expired'

export type JoinDecision =
  | { kind: 'accept'; payload: HostMeshOfferPayload }
  | { kind: 'refuse'; reason: JoinRefusal }

export type InboundJoin = {
  joiner: { hostKey: string; label: string }
  openedPayload: HostMeshOfferPayload | null
  openReason?: string
  now: number
}

/**
 * A join differs from an introduction in exactly one way: the joiner proved itself by pairing with this
 * host by hand, so there is no introducer to check. Everything else — the box being ours, being the
 * joiner's, being unexpired — still has to hold, or a paired peer could pair this host with a machine it
 * merely claims to be.
 */
export function decideJoin(
  state: HostMeshState,
  settings: HostMeshSettings,
  join: InboundJoin
): JoinDecision {
  if (!settings.enabled) {
    return { kind: 'refuse', reason: 'joins-not-allowed' }
  }
  if (join.joiner.hostKey === state.selfKey) {
    return { kind: 'refuse', reason: 'offer-not-from-joiner' }
  }
  if (state.tombstones.some((tombstone) => tombstone.hostKey === join.joiner.hostKey)) {
    return { kind: 'refuse', reason: 'tombstoned' }
  }
  if (
    !state.members.some((member) => member.hostKey === join.joiner.hostKey) &&
    state.members.length >= HOST_MESH_MAX_MEMBERS
  ) {
    return { kind: 'refuse', reason: 'at-cap' }
  }
  const payload = join.openedPayload
  if (payload === null) {
    return { kind: 'refuse', reason: mapJoinOpenReason(join.openReason) }
  }
  if (payload.recipientHostKey !== state.selfKey) {
    return { kind: 'refuse', reason: 'offer-not-addressed-here' }
  }
  if (payload.minterHostKey !== join.joiner.hostKey) {
    return { kind: 'refuse', reason: 'offer-not-from-joiner' }
  }
  if (payload.expiresAt <= join.now) {
    return { kind: 'refuse', reason: 'offer-expired' }
  }
  return { kind: 'accept', payload }
}

/** Which members still need a offer from a newcomer, so a relay batch is never sent twice for one pair. */
export function membersAwaitingNewcomerOffer(
  state: HostMeshState,
  joinerHostKey: string
): string[] {
  return state.members
    .filter((member) => member.hostKey !== joinerHostKey)
    .filter((member) => {
      const link = state.links.outbound[member.hostKey]?.kind
      // Why the two dead kinds are excluded: an offer minted for a machine that cannot answer is a live
      // device row nobody will ever redeem, and the repair would mint another one on every pass.
      return link !== 'ok' && link !== 'unreachable' && link !== 'unsupported'
    })
    .map((member) => member.hostKey)
}

function mapOpenReason(reason: string | undefined): IntroduceRefusal {
  if (reason === 'offer-expired') {
    return 'offer-expired'
  }
  if (reason === 'offer-sender') {
    return 'offer-sender-mismatch'
  }
  return 'offer-not-addressed-here'
}

function mapJoinOpenReason(reason: string | undefined): JoinRefusal {
  if (reason === 'offer-expired') {
    return 'offer-expired'
  }
  return 'offer-not-from-joiner'
}

/** Kept next to the rules so a caller cannot build a box the decisions above would then refuse. */
export function sealedOfferAddressedTo(sealed: HostMeshSealedOffer, hostKey: string): boolean {
  return sealed.recipientHostKey === hostKey
}

export type OfferBackRefusal =
  | 'caller-not-paired'
  | 'reverse-offers-disabled'
  | 'self-offer'
  | 'tombstoned'
  | 'at-cap'
  | 'offer-not-addressed-here'
  | 'offer-sender-mismatch'
  | 'offer-expired'
  | 'group-mismatch'
  | 'redeem-failed'
  | 'offer-not-from-offerer'
  | 'group-not-adoptable'

export type OfferBackDecision =
  | { kind: 'accept'; payload: HostMeshOfferPayload }
  | { kind: 'refuse'; reason: OfferBackRefusal }

export type InboundOfferBack = {
  /** The device this host paired that made the call; absent means the call carried no such credential. */
  callerPairedDeviceId?: string
  offererHostKey: string
  /** `null` when the envelope did not open; the reason travels separately so this stays pure. */
  openedPayload: HostMeshOfferPayload | null
  openReason?: string
  now: number
}

/**
 * Whether this host takes an offer from a machine that already holds a credential here.
 *
 * Why the paired device is the whole trust argument: the caller reached this method over a token this host
 * issued, which is the same standing a direct pairing gives and stronger than any key it can claim. What the box
 * adds is self-certifying — it names a minter key, and the offer inside it is an ordinary pairing offer whose own
 * key must hash to that name — so a caller cannot present itself as a different machine. The residual limit is
 * stated in `local/design/host-mesh.md`: a machine this host already trusts can add itself to the group.
 */
export function decideOfferBack(
  state: HostMeshState,
  settings: HostMeshSettings,
  offer: InboundOfferBack
): OfferBackDecision {
  if (offer.callerPairedDeviceId === undefined) {
    return { kind: 'refuse', reason: 'caller-not-paired' }
  }
  if (!settings.enabled) {
    return { kind: 'refuse', reason: 'reverse-offers-disabled' }
  }
  if (offer.offererHostKey === state.selfKey) {
    return { kind: 'refuse', reason: 'self-offer' }
  }
  if (state.tombstones.some((tombstone) => tombstone.hostKey === offer.offererHostKey)) {
    return { kind: 'refuse', reason: 'tombstoned' }
  }
  if (
    !state.members.some((member) => member.hostKey === offer.offererHostKey) &&
    state.members.length >= HOST_MESH_MAX_MEMBERS
  ) {
    return { kind: 'refuse', reason: 'at-cap' }
  }
  const payload = offer.openedPayload
  if (payload === null) {
    return { kind: 'refuse', reason: offerBackOpenReason(offer.openReason) }
  }
  if (payload.recipientHostKey !== state.selfKey) {
    return { kind: 'refuse', reason: 'offer-not-addressed-here' }
  }
  // Why the minter must be the caller's claimed key: the box is what binds the claim, so an offer minted by any
  // other machine is not the one this host was promised.
  if (payload.minterHostKey !== offer.offererHostKey) {
    return { kind: 'refuse', reason: 'offer-sender-mismatch' }
  }
  if (payload.expiresAt <= offer.now) {
    return { kind: 'refuse', reason: 'offer-expired' }
  }
  // Why a group is required here: this offer is what teaches a host in no group which one the machine that dials
  // it is in, and an offer naming no group at all would put this host in one it cannot render.
  if (payload.groupId === '') {
    return { kind: 'refuse', reason: 'group-mismatch' }
  }
  return { kind: 'accept', payload }
}

/** The envelope's own words, narrowed to this refusal vocabulary rather than widened to another's. */
function offerBackOpenReason(reason: string | undefined): OfferBackRefusal {
  return reason === 'offer-expired' ? 'offer-expired' : 'offer-sender-mismatch'
}
