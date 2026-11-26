import type { HostMeshSealedOffer } from '../../shared/host-mesh/host-mesh-contract'
import { readBoxes } from './host-mesh-store-boxes'
import type { StoredFile } from './host-mesh-store'

/**
 * The boxes other hosts ask this one to hold for a newcomer.
 *
 * Why this is its own module: it is the only part of the store that writes a value it does not read — a box
 * goes in addressed to a machine that will collect it later — and keeping it apart keeps the store's own
 * read-modify-write small enough to stay inside the line budget.
 */
export type PendingBoxAccess = {
  read: () => StoredFile | null
  write: (file: StoredFile) => void
  empty: () => StoredFile
}

export function createPendingBoxStore(access: PendingBoxAccess) {
  return {
    readPendingBoxes: (recipientHostKey: string): HostMeshSealedOffer[] =>
      readBoxes(access.read()?.pendingBoxes[recipientHostKey]),

    takePendingBoxes: (recipientHostKey: string): HostMeshSealedOffer[] => {
      const file = access.read() ?? access.empty()
      const boxes = readBoxes(file.pendingBoxes[recipientHostKey])
      if (boxes.length === 0) {
        return []
      }
      const { [recipientHostKey]: _taken, ...pendingBoxes } = file.pendingBoxes
      access.write({ ...file, pendingBoxes })
      return boxes
    },

    /**
     * Why a duplicate nonce is dropped: the same box delivered twice would be redeemed twice, and the
     * newcomer would redeem one and hold a second dead credential for the same member.
     */
    addPendingBox: (recipientHostKey: string, sealed: HostMeshSealedOffer): void => {
      const file = access.read() ?? access.empty()
      const held = readBoxes(file.pendingBoxes[recipientHostKey])
      if (held.some((box) => box.nonceB64 === sealed.nonceB64)) {
        return
      }
      access.write({
        ...file,
        pendingBoxes: { ...file.pendingBoxes, [recipientHostKey]: [...held, sealed] }
      })
    }
  }
}
