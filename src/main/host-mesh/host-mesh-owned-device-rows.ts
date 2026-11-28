import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { createHostMeshStore } from './host-mesh-store'

/**
 * The device rows this host minted for a mesh member, by id.
 *
 * Why the peer index answers this: it is what records that a row was minted for a machine — the same grouping
 * removal trusts to revoke a whole set — so a row's owner is a question about the group, not about the registry's
 * own table, which stays free of mesh bookkeeping.
 *
 * Why an empty set on failure: this decides what Settings lists, and a group file that cannot be read must not
 * make every link disappear.
 */
export function meshOwnedDeviceRowIds(
  userDataPath: string = getCanonicalUserDataPath()
): ReadonlySet<string> {
  try {
    const peerIndex = createHostMeshStore({ userDataPath }).readPeerIndex()
    return new Set([...peerIndex.values()].flatMap((entry) => entry.deviceRowIds))
  } catch {
    return new Set()
  }
}
