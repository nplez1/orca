import { HOST_MESH_MAX_MEMBERS, type HostMeshState } from './host-mesh-contract'

/**
 * A group another host is offering this one, as that host describes it.
 *
 * `hostKeys` is every machine the offer says is in the group, including the offerer, because the trust
 * check below is about the whole set rather than about the machine doing the talking.
 */
export type HostMeshGroupOffer = {
  groupId: string
  epoch: number
  hostKeys: readonly string[]
}

export type HostMeshAdoption =
  | { kind: 'adopt'; state: HostMeshState }
  | { kind: 'keep'; reason: 'already-in-it' | 'ours-is-bigger' }
  | { kind: 'refuse'; reason: 'no-group-offered' | 'group-not-yours' | 'at-cap' }

/**
 * Decides whether this host may take on a group another host is offering.
 *
 * Why a host adopts at all: the group id is derived per host, so two machines upgraded from the same fleet
 * arrive with different ids, and a machine that has never joined has none at all. Without a rule for taking
 * one on, the fleet splits into groups that can never reach each other — which is exactly the case an
 * upgrade creates for every existing install.
 *
 * Why the trust check: adoption is the one path where a peer, rather than this host's owner, decides what
 * this host's group is. If it were ungated, a member could name a group of machines this host has never
 * heard of, and this host would then pair with all of them and mint credentials for each. So an offer is
 * taken only when every machine it names is already paired here: a peer may point this host at the fleet it
 * already trusts, never at a fleet of its own choosing.
 */
export function adoptHostMeshGroup(
  state: HostMeshState,
  offer: HostMeshGroupOffer,
  args: {
    isTrusted: (hostKey: string) => boolean
    /**
     * Machines a trusted peer is vouching for in this very offer — today, the newcomer of an introduction.
     *
     * Why this is not a hole in the trust check: the whole premise of the group is that a member looks at a
     * machine and says "you want this one", and refusing the voucher would mean no machine that has not
     * already been paired by hand could ever join. What it does not do is let the offer name a machine
     * nobody here speaks for, and every consequence stays bounded — a member cap, four introductions an hour,
     * and the newcomer can be ejected.
     */
    vouched?: readonly string[]
  }
): HostMeshAdoption {
  if (offer.groupId === '') {
    return { kind: 'refuse', reason: 'no-group-offered' }
  }
  if (offer.groupId === state.groupId) {
    return { kind: 'keep', reason: 'already-in-it' }
  }
  const offered = new Set(offer.hostKeys)
  // An offer that does not name this host is not about this host, however it reached us.
  if (!offered.has(state.selfKey)) {
    return { kind: 'refuse', reason: 'group-not-yours' }
  }
  const vouched = new Set(args.vouched ?? [])
  for (const hostKey of offered) {
    if (hostKey !== state.selfKey && !args.isTrusted(hostKey) && !vouched.has(hostKey)) {
      return { kind: 'refuse', reason: 'group-not-yours' }
    }
  }
  // Why containment rather than overlap: a larger group wins only when it contains this host's group whole.
  // Two fleets that happen to share one machine must not merge through it, and this host's own group is the
  // authority on the members it already has.
  if (!state.members.every((member) => offered.has(member.hostKey))) {
    return { kind: 'keep', reason: 'ours-is-bigger' }
  }
  const joining = [...offered].filter(
    (hostKey) =>
      hostKey !== state.selfKey && !state.members.some((member) => member.hostKey === hostKey)
  )
  if (state.members.length + joining.length > HOST_MESH_MAX_MEMBERS) {
    return { kind: 'refuse', reason: 'at-cap' }
  }
  return {
    kind: 'adopt',
    // Why the epoch moves: taking on another group's id is a membership change, and a stale epoch would let
    // this host's older view of the same group win a later comparison against its own.
    state: {
      ...state,
      groupId: offer.groupId,
      epoch: Math.max(state.epoch, offer.epoch) + 1
    }
  }
}
