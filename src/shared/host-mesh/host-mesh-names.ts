import {
  HOST_MESH_MAX_LABEL_CHARS,
  HOST_MESH_NAME_MAX_VERSION,
  HOST_MESH_NAME_SEED_VERSION,
  type HostMeshName,
  type HostMeshState
} from './host-mesh-contract'

/**
 * The group's names for its machines, as a versioned register.
 *
 * Why its own module: a name is the one fact about a member that any host may change, and it arrives from a peer, so
 * the merge rules are a boundary worth reading on their own.
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
  const version = Math.min(
    Math.max(
      state.names[args.hostKey]?.version ?? HOST_MESH_NAME_SEED_VERSION,
      HOST_MESH_NAME_SEED_VERSION
    ) + 1,
    HOST_MESH_NAME_MAX_VERSION
  )
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
 *
 * Why `allowed` is a parameter: the map arrives from a member that could name a machine this group has never heard
 * of, and a name for nothing is one more row every host has to carry forever.
 */
export function mergeHostMeshNames(
  current: Readonly<Record<string, HostMeshName>>,
  incoming: Readonly<Record<string, HostMeshName>> | undefined,
  allowed?: ReadonlySet<string>
): Record<string, HostMeshName> {
  const merged: Record<string, HostMeshName> = { ...current }
  for (const [hostKey, candidate] of Object.entries(incoming ?? {})) {
    if (
      hostKey === '' ||
      isPrototypeKey(hostKey) ||
      (allowed !== undefined && !allowed.has(hostKey)) ||
      !isUsableName(candidate, hostKey)
    ) {
      continue
    }
    const existing = merged[hostKey]
    if (existing === undefined || compareHostMeshNames(candidate, existing) > 0) {
      merged[hostKey] = { label: candidate.label.trim(), version: candidate.version }
    }
  }
  return merged
}

/** Keys that assign a prototype rather than an entry, which a peer's map must never be trusted to spell. */
function isPrototypeKey(hostKey: string): boolean {
  return hostKey === '__proto__' || hostKey === 'constructor' || hostKey === 'prototype'
}

function compareHostMeshNames(left: HostMeshName, right: HostMeshName): number {
  if (left.version !== right.version) {
    return left.version - right.version
  }
  // Compared in the form that is stored, so two hosts cannot disagree about a name over whitespace alone.
  const leftLabel = left.label.trim()
  const rightLabel = right.label.trim()
  if (leftLabel === rightLabel) {
    return 0
  }
  // Code-unit order, not locale order: both ends must land on the same winner.
  return leftLabel > rightLabel ? 1 : -1
}

/** Why every field is bounded: this arrives from a peer, and it is persisted and relayed to the whole fleet. */
function isUsableName(name: HostMeshName | undefined, hostKey: string): name is HostMeshName {
  if (name === undefined || typeof name.label !== 'string') {
    return false
  }
  const label = name.label.trim()
  return (
    hostKey !== '' &&
    label !== '' &&
    label.length <= HOST_MESH_MAX_LABEL_CHARS &&
    Number.isSafeInteger(name.version) &&
    name.version >= 0 &&
    name.version <= HOST_MESH_NAME_MAX_VERSION
  )
}
