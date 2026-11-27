import {
  HOST_MESH_MAX_MEMBERS,
  type HostMeshInboundLink,
  type HostMeshLinkMatrix,
  type HostMeshMember,
  type HostMeshOutboundLink,
  type HostMeshState,
  type HostMeshSyncPayload
} from './host-mesh-contract'
import { mergeHostMeshNames } from './host-mesh-names'
import { rememberRoutes } from './host-mesh-routes'

// The routes reducer lives with the route helpers; re-exported so the membership API reads as one surface.
export { setHostMeshRoutes } from './host-mesh-routes'
/**
 * The group's rules, as a pure reducer.
 *
 * Why pure: every operation here decides who may reach this machine, and the consequences of getting it
 * wrong — a member that cannot be removed, a duplicate that halves the fleet, a tombstone that loses to a
 * stale sync — are invisible at runtime. They are only cheap to check against arguments.
 *
 * Why tombstones are a union and members are a union: two members syncing disagree about the set, and the
 * only merge that never resurrects a removed machine is "removal wins, forever", carried by every member.
 */

export type HostMeshMemberOutcome = 'added' | 'alreadyMember' | 'tombstoned' | 'capReached'

export function createHostMeshState(args: {
  selfKey: string
  groupId: string
  epoch: number
}): HostMeshState {
  return {
    groupId: args.groupId,
    epoch: args.epoch,
    selfKey: args.selfKey,
    members: [],
    tombstones: [],
    links: { outbound: {}, inbound: {} },
    names: {},
    routes: {}
  }
}

/**
 * Why the introducer is added as a member: joining a group means being paired with the host that invited
 * you, and that pairing is the one the user performed by hand.
 */
export function hostMeshJoin(
  state: HostMeshState,
  args: { groupId: string; epoch: number; introducer: { hostKey: string; label: string } }
): HostMeshState {
  const joined = addHostMeshMember(
    { ...state, groupId: args.groupId, epoch: Math.max(state.epoch, args.epoch) },
    { hostKey: args.introducer.hostKey, label: args.introducer.label, epoch: args.epoch }
  )
  return joined.state
}

export function addHostMeshMember(
  state: HostMeshState,
  args: {
    hostKey: string
    label: string
    publicKeyB64?: string
    introducedBy?: string
    epoch: number
  }
): { state: HostMeshState; outcome: HostMeshMemberOutcome } {
  const { hostKey } = args
  if (hostKey === state.selfKey) {
    return { state, outcome: 'alreadyMember' }
  }
  if (state.tombstones.some((tombstone) => tombstone.hostKey === hostKey)) {
    return { state, outcome: 'tombstoned' }
  }
  const existing = state.members.find((member) => member.hostKey === hostKey)
  if (existing !== undefined) {
    // Why the label is refreshed: a machine that was renamed is the same machine, and the newest
    // introduction is the newest name it gave.
    const members = state.members.map((member) =>
      member.hostKey === hostKey
        ? { ...member, label: args.label, publicKeyB64: args.publicKeyB64 ?? member.publicKeyB64 }
        : member
    )
    return { state: { ...state, members }, outcome: 'alreadyMember' }
  }
  if (state.members.length >= HOST_MESH_MAX_MEMBERS) {
    return { state, outcome: 'capReached' }
  }
  const member: HostMeshMember = {
    hostKey,
    label: args.label,
    ...(args.publicKeyB64 === undefined ? {} : { publicKeyB64: args.publicKeyB64 }),
    ...(args.introducedBy === undefined ? {} : { introducedBy: args.introducedBy }),
    addedAtEpoch: args.epoch
  }
  return {
    state: {
      ...state,
      epoch: Math.max(state.epoch, args.epoch),
      members: [...state.members, member],
      links: {
        outbound: {
          ...state.links.outbound,
          [hostKey]: state.links.outbound[hostKey] ?? {
            kind: 'awaitingOffer',
            requestedAtEpoch: args.epoch,
            expiresAt: 0
          }
        },
        inbound: {
          ...state.links.inbound,
          [hostKey]: state.links.inbound[hostKey] ?? { kind: 'absent' }
        }
      }
    },
    outcome: 'added'
  }
}

/**
 * Why removal wins even when the remover is itself removed later: the union of tombstones is what every
 * member carries, so a group can only shrink by agreement and never oscillates back.
 */
export function removeHostMeshMember(
  state: HostMeshState,
  args: { hostKey: string; removedBy: string; epoch: number }
): HostMeshState {
  const { hostKey } = args
  const tombstone = { hostKey, removedBy: args.removedBy, epoch: args.epoch }
  const tombstones = [
    ...state.tombstones.filter((existing) => existing.hostKey !== hostKey),
    tombstone
  ]
  const members = state.members.filter((member) => member.hostKey !== hostKey)
  if (hostKey === state.selfKey) {
    return { ...state, members, tombstones }
  }
  const { [hostKey]: _outbound, ...outbound } = state.links.outbound
  const { [hostKey]: _inbound, ...inbound } = state.links.inbound
  const { [hostKey]: _name, ...names } = state.names
  const { [hostKey]: _routes, ...routes } = state.routes
  return {
    groupId: state.groupId,
    epoch: Math.max(state.epoch, args.epoch),
    selfKey: state.selfKey,
    members,
    tombstones,
    links: { outbound, inbound },
    names,
    routes
  }
}

/** Leaving is self-removal plus the local group identity; the members keep the tombstone. */
export function leaveHostMeshGroup(state: HostMeshState, args: { epoch: number }): HostMeshState {
  return {
    groupId: '',
    epoch: args.epoch,
    selfKey: state.selfKey,
    members: [],
    // Why no self-tombstone: a tombstone naming this host is read as "this host was ejected", and one
    // written on the way out would make every future rejoin look like that. The members keep their own.
    tombstones: [],
    links: { outbound: {}, inbound: {} },
    // Why this host's own name survives: it is what the group calls this machine, and a rejoin would
    // otherwise reintroduce it under a placeholder.
    names:
      state.names[state.selfKey] === undefined
        ? {}
        : { [state.selfKey]: state.names[state.selfKey] },
    // Why the routes go: this host is in no group, so it has no member whose address it could dial.
    routes: {}
  }
}

/**
 * Merge another member's view.
 *
 * Why members and tombstones are unioned rather than replaced: each member knows links the sender does
 * not, and a replacement would let a stale peer delete a live machine. A member the sender has never
 * heard of is simply new information.
 */
export function applyHostMeshSync(
  state: HostMeshState,
  payload: HostMeshSyncPayload
): HostMeshState {
  if (payload.groupId !== state.groupId) {
    return state
  }
  const tombstones = unionTombstones(state.tombstones, payload.tombstones)
  const removed = new Set(tombstones.map((tombstone) => tombstone.hostKey))
  const members = [...state.members]
  for (const incoming of payload.members) {
    if (incoming.hostKey === state.selfKey || removed.has(incoming.hostKey)) {
      continue
    }
    const existing = members.find((member) => member.hostKey === incoming.hostKey)
    if (existing === undefined) {
      if (members.length >= HOST_MESH_MAX_MEMBERS) {
        continue
      }
      members.push(incoming)
      continue
    }
    if (incoming.addedAtEpoch > existing.addedAtEpoch) {
      existing.label = incoming.label
      existing.addedAtEpoch = incoming.addedAtEpoch
    }
    if (existing.publicKeyB64 === undefined && incoming.publicKeyB64 !== undefined) {
      existing.publicKeyB64 = incoming.publicKeyB64
    }
  }
  const names = mergeHostMeshNames(
    state.names,
    payload.names,
    // Why the set: a peer may name a machine this group does not have, and a name for nothing is a row every host
    // carries forever. A removed machine is left out too, or its name would come back with the next introduction.
    new Set([
      state.selfKey,
      ...members.filter((member) => !removed.has(member.hostKey)).map((member) => member.hostKey)
    ])
  )
  const links: HostMeshLinkMatrix = {
    outbound: { ...state.links.outbound },
    inbound: { ...state.links.inbound }
  }
  // Why only the sender's own matrix: a member can say what it holds about this host, but a claim about
  // some third member's link is one it has no standing to make, and believing it would misdraw that row.
  for (const [hostKey, matrix] of Object.entries(payload.links).filter(
    ([key]) => key === payload.selfKey
  )) {
    // Why the sender's view of our own outbound link is ignored: a link this host owns is only ever
    // written by this host, or a peer could claim a pairing that does not exist.
    if (hostKey === state.selfKey) {
      continue
    }
    const inbound = matrix.outbound[state.selfKey]
    if (inbound !== undefined) {
      links.inbound[hostKey] = normalizeInbound(inbound)
    }
  }
  // Why the winning name is mirrored onto the member rows: an introduction carries `member.label`, so a row left
  // holding the name it arrived with would reintroduce the machine under a name the group has already replaced.
  for (const member of members) {
    const name = names[member.hostKey]
    if (name !== undefined) {
      member.label = name.label
    }
  }
  // Why only the sender's own routes: a member can say where it is, and a claim about a third machine's address
  // is one it would be dialing second-hand — the same reason its link matrix is read only for itself.
  const routes = Object.fromEntries(
    Object.entries(state.routes).filter(([hostKey]) => !removed.has(hostKey))
  )
  const senderIsKnown = state.members.some((member) => member.hostKey === payload.selfKey)
  if (payload.selfKey !== state.selfKey && senderIsKnown && payload.endpoints !== undefined) {
    const remembered = rememberRoutes({
      previous: routes[payload.selfKey],
      reported: payload.endpoints
    })
    if (remembered.length > 0) {
      routes[payload.selfKey] = remembered
    }
  }
  return {
    ...state,
    epoch: Math.max(state.epoch, payload.epoch),
    members: members.filter((member) => !removed.has(member.hostKey)),
    tombstones,
    links,
    names,
    routes
  }
}

export function setHostMeshOutboundLink(
  state: HostMeshState,
  args: { hostKey: string; link: HostMeshOutboundLink }
): HostMeshState {
  return {
    ...state,
    links: { ...state.links, outbound: { ...state.links.outbound, [args.hostKey]: args.link } }
  }
}

/**
 * Marks the direction a member holds TO this host.
 *
 * Why receiving a sealed box is evidence of it: only a host that just redeemed our offer mints one back with
 * a real offer inside, so a box from a member means that member holds a credential for us. The bound is that
 * a hostile member could claim this falsely, which misdraws one row's status and grants it nothing.
 */
export function setHostMeshInboundLink(
  state: HostMeshState,
  args: { hostKey: string; link: HostMeshInboundLink }
): HostMeshState {
  return {
    ...state,
    links: { ...state.links, inbound: { ...state.links.inbound, [args.hostKey]: args.link } }
  }
}

export type HostMeshGroupSummary = {
  memberCount: number
  /** Pairs joined at both ends. */
  completePairs: number
  /** Pairs with exactly one direction recorded. */
  halfPairs: number
  /** Pairs this host still has to establish. */
  missingPairs: number
  atCap: boolean
}

export function summarizeHostMesh(state: HostMeshState): HostMeshGroupSummary {
  let completePairs = 0
  let halfPairs = 0
  let missingPairs = 0
  for (const member of state.members) {
    const outboundOk = state.links.outbound[member.hostKey]?.kind === 'ok'
    const inboundOk = state.links.inbound[member.hostKey]?.kind === 'active'
    if (outboundOk && inboundOk) {
      completePairs += 1
    } else if (outboundOk || inboundOk) {
      halfPairs += 1
    } else {
      missingPairs += 1
    }
  }
  return {
    memberCount: state.members.length,
    completePairs,
    halfPairs,
    missingPairs,
    atCap: state.members.length >= HOST_MESH_MAX_MEMBERS
  }
}

function unionTombstones(
  current: readonly HostMeshState['tombstones'][number][],
  incoming: readonly HostMeshState['tombstones'][number][]
): HostMeshState['tombstones'] {
  const byKey = new Map<string, HostMeshState['tombstones'][number]>()
  for (const tombstone of [...current, ...incoming]) {
    const existing = byKey.get(tombstone.hostKey)
    if (existing === undefined || tombstone.epoch > existing.epoch) {
      byKey.set(tombstone.hostKey, tombstone)
    }
  }
  return [...byKey.values()]
}

function normalizeInbound(link: HostMeshOutboundLink): HostMeshInboundLink {
  if (link.kind === 'ok') {
    return { kind: 'active' }
  }
  if (link.kind === 'awaitingOffer') {
    return { kind: 'awaitingRedeem', expiresAt: link.expiresAt }
  }
  return { kind: 'absent' }
}
