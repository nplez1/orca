import {
  HOST_MESH_NAME_SEED_VERSION,
  type HostMeshName,
  type HostMeshState
} from './host-mesh-contract'

/**
 * The group's names for its machines, as a versioned register.
 *
 * Why its own module: a name is the one fact about a member that any host may change, so the merge rules are worth
 * reading on their own rather than as the tail of the membership reducer.
 */

/**
 * Renames one machine for the whole group.
 *
 * Why the version always beats a seed: a name the owner typed outranks one inherited from a pairing, so an explicit
 * rename has to win over any name a host happens to hold from its own environment list.
 */
export function setHostMeshName(
  state: HostMeshState,
  args: { hostKey: string; label: string }
): HostMeshState {
  const label = args.label.trim()
  const version =
    Math.max(
      state.names[args.hostKey]?.version ?? HOST_MESH_NAME_SEED_VERSION,
      HOST_MESH_NAME_SEED_VERSION
    ) + 1
  return {
    ...state,
    names: { ...state.names, [args.hostKey]: { label, version } },
    // The member row mirrors the group's word, so an introduction carries the name rather than an old one.
    members: state.members.map((member) =>
      member.hostKey === args.hostKey ? { ...member, label } : member
    )
  }
}

/**
 * Union of names, newest version per machine; a peer's claim never erases one this host holds higher.
 *
 * Why equal versions break on the word itself: two owners renaming the same host at the same version would otherwise
 * keep their own — every host would be right locally and the fleet would never agree. Comparing the words gives the
 * same answer everywhere, so they converge on one of the two instead.
 */
export function mergeHostMeshNames(
  current: Readonly<Record<string, HostMeshName>>,
  incoming: Readonly<Record<string, HostMeshName>> | undefined
): Record<string, HostMeshName> {
  const merged: Record<string, HostMeshName> = { ...current }
  for (const [hostKey, candidate] of Object.entries(incoming ?? {})) {
    if (hostKey === '' || !isUsableName(candidate)) {
      continue
    }
    const existing = merged[hostKey]
    if (existing === undefined || compareHostMeshNames(candidate, existing) > 0) {
      merged[hostKey] = { label: candidate.label.trim(), version: candidate.version }
    }
  }
  return merged
}

function compareHostMeshNames(left: HostMeshName, right: HostMeshName): number {
  if (left.version !== right.version) {
    return left.version - right.version
  }
  if (left.label === right.label) {
    return 0
  }
  // Code-unit order, not locale order: both ends must land on the same winner.
  return left.label > right.label ? 1 : -1
}

function isUsableName(name: HostMeshName | undefined): name is HostMeshName {
  return (
    name !== undefined &&
    typeof name.label === 'string' &&
    name.label.trim() !== '' &&
    Number.isFinite(name.version)
  )
}
