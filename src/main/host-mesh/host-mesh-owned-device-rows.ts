import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { createHostMeshStore } from './host-mesh-store'

/**
 * The device rows this host minted as mesh offers, by id.
 *
 * Why the peer index answers this: it records which rows were minted for which machine — the same grouping removal
 * trusts to revoke a whole set — and `mintedRowIds` is the subset this host minted itself, as against a row a peer
 * joined through, which is the owner's link and stays listed.
 *
 * Why only while a group is joined and the mesh is on: a row left behind by a group this host left is swept by
 * nothing, so hiding it would hide a live credential from the only surface that can revoke it. Once the mesh stops
 * managing a row, the row goes back to being the owner's to see.
 *
 * Why an empty set on failure: this decides what Settings lists, and a group file that cannot be read must not make
 * every link disappear.
 */
export function meshOwnedDeviceRowIds(
  userDataPath: string = getCanonicalUserDataPath()
): ReadonlySet<string> {
  try {
    const store = createHostMeshStore({ userDataPath })
    const state = store.read()
    if (!store.readSettings().enabled || state === null || state.groupId === '') {
      return new Set()
    }
    const members = new Set(state.members.map((member) => member.hostKey))
    const owned = new Set<string>()
    for (const [hostKey, entry] of store.readPeerIndex()) {
      if (!members.has(hostKey)) {
        continue
      }
      for (const id of entry.mintedRowIds ?? entry.deviceRowIds) {
        owned.add(id)
      }
    }
    return owned
  } catch {
    return new Set()
  }
}
