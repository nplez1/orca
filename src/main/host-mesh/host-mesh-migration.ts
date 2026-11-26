import { createHash } from 'node:crypto'
import {
  HOST_MESH_MAX_MEMBERS,
  type HostMeshState
} from '../../shared/host-mesh/host-mesh-contract'
import { addHostMeshMember, createHostMeshState } from '../../shared/host-mesh/host-mesh-membership'

/** Bumped when what an upgrade derives changes; the store records it so a second shape is not re-applied. */
export const HOST_MESH_MIGRATION_VERSION = 1

/**
 * The group id two hosts upgrading from the same fleet arrive at independently.
 *
 * Why derived rather than random: migration happens on each machine at its own time, with no coordinator and
 * no network call, so a random id would give every machine its own group and the fleet would never converge
 * without one of them joining deliberately. Deriving it from the members makes two machines that saw the same
 * fleet agree, and `adoptHostMeshGroup` settles the case where they did not see the same fleet.
 *
 * Why sorted: the id must not depend on the order a pairing table happened to be read in.
 */
export function hostMeshGroupIdFor(hostKeys: readonly string[]): string {
  const digest = createHash('sha256')
    .update([...hostKeys].sort().join('\n'))
    .digest('hex')
  return `mesh-${digest.slice(0, 16)}`
}

export type HostMeshMigrationPlan = {
  state: HostMeshState
  /** How many machines the group was created from, which is what the panel reports. */
  peerCount: number
}

/**
 * The group an existing install becomes the first time it runs a build with the mesh in it.
 *
 * Why migrate at all: pairing is directional, so every install already holds the machines it was paired with
 * — but nothing groups them, and the group is what makes the workspace list identical everywhere. Without
 * this, an upgrade leaves every existing fleet exactly as scattered as it was and asks the owner to start
 * over with a create-group action per machine.
 *
 * Why the members are added with no credential claimed: this host has a pairing with each of them, not a
 * group with them. Every link starts `absent` and stays that way until a sync or an introduction proves it,
 * so the panel shows an unrepaired fleet rather than a false one.
 *
 * Null when there is nothing to migrate: a machine with no pairings is a fresh install, and inventing an
 * empty group for it would be a group the owner never asked for.
 */
export function planHostMeshMigration(args: {
  selfKey: string
  /**
   * `publicKeyB64` is not optional in practice even though the type allows its absence: without it nothing can
   * be sealed to that member, so the repair silently skips it and the fleet never repairs itself.
   */
  peers: readonly { hostKey: string; label: string; publicKeyB64?: string }[]
}): HostMeshMigrationPlan | null {
  const seen = new Set<string>()
  const peers = args.peers.filter((peer) => {
    if (peer.hostKey === args.selfKey || peer.hostKey === '' || seen.has(peer.hostKey)) {
      return false
    }
    seen.add(peer.hostKey)
    return true
  })
  if (peers.length === 0) {
    return null
  }
  const capped = peers.slice(0, HOST_MESH_MAX_MEMBERS)
  let state = createHostMeshState({
    selfKey: args.selfKey,
    groupId: hostMeshGroupIdFor([args.selfKey, ...capped.map((peer) => peer.hostKey)]),
    epoch: 1
  })
  for (const peer of capped) {
    state = addHostMeshMember(state, {
      hostKey: peer.hostKey,
      label: peer.label,
      ...(peer.publicKeyB64 === undefined ? {} : { publicKeyB64: peer.publicKeyB64 }),
      epoch: 1
    }).state
  }
  return { state, peerCount: capped.length }
}
