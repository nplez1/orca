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
  /** Accept machines introduced by current members without asking this host's owner. */
  autoAcceptIntroducedMembers: boolean
  /** Accept introductions at all. Off means this host takes joins but admits nobody transitively. */
  acceptIntroductions: boolean
  /** Forward a newcomer's offers to other members on its behalf. */
  relayIntroductions: boolean
  /**
   * Whether a paired machine may put this host into a group at all.
   *
   * Why off by default: a join is what makes this host mint offers and dial endpoints, and a join is
   * `workspace`-tier, so a paired desktop could otherwise bootstrap this host into a group without its
   * owner acting. Turning it on is one action per machine — the same count the feature promises.
   */
  allowJoins: boolean
}

/** Why the default is on: asking per introduction on every machine is the n(n−1) problem in another form. */
export const DEFAULT_HOST_MESH_SETTINGS: HostMeshSettings = {
  autoAcceptIntroducedMembers: true,
  acceptIntroductions: true,
  relayIntroductions: true,
  allowJoins: false
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
  | { kind: 'ask'; payload: HostMeshOfferPayload }
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
  if (!settings.acceptIntroductions) {
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
  return settings.autoAcceptIntroducedMembers
    ? { kind: 'accept', payload }
    : { kind: 'ask', payload }
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
  | { kind: 'ask'; payload: HostMeshOfferPayload }
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
  if (!settings.allowJoins) {
    return { kind: 'refuse', reason: 'joins-not-allowed' }
  }
  if (!settings.relayIntroductions) {
    return { kind: 'refuse', reason: 'joins-disabled' }
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
  return settings.autoAcceptIntroducedMembers
    ? { kind: 'accept', payload }
    : { kind: 'ask', payload }
}

/** Which members still need a offer from a newcomer, so a relay batch is never sent twice for one pair. */
export function membersAwaitingNewcomerOffer(
  state: HostMeshState,
  joinerHostKey: string
): string[] {
  return state.members
    .filter((member) => member.hostKey !== joinerHostKey)
    .filter((member) => state.links.outbound[member.hostKey]?.kind !== 'ok')
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
