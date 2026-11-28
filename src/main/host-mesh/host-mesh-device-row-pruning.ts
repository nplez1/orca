import type { HostMeshRuntimeServer } from './host-mesh-runtime-deps'

/**
 * Just the fields the sweep reads, so it never imports the registry.
 *
 * Kept separate from the registry's own `DeviceEntry`: the sweep is a reader of someone else's table, and a
 * structural type is what makes that table's shape visible in the one place that depends on it.
 */
export type MeshDeviceRow = {
  deviceId: string
  scope: string
  lastSeenAt: number
  offerExpiresAt?: number
  parentDeviceId?: string
  forkedFrom?: string
  createdByDeviceId?: string
}

/** The two things a revoking sweep needs from the server, so a caller only has to be structurally that. */
export type MeshDeviceRowServer = Pick<HostMeshRuntimeServer, 'revokeRuntimeAccess'> & {
  getDeviceRegistry: () => {
    listDevices: (options?: { fresh?: boolean }) => readonly MeshDeviceRow[]
    removeDevice: (deviceId: string) => boolean
  } | null
}

/** One peer's rows: everything the index holds, and the ids this host minted, oldest first. */
export type MeshPeerRows = {
  all: readonly string[]
  /** Mint order is the order the index appended them, which is what makes it a sequence and not a clock. */
  minted: readonly string[]
}

/** Rows another row was minted from, so a sweep can leave a parent alone. */
function parentsOf(rows: readonly MeshDeviceRow[]): ReadonlySet<string> {
  const parents = new Set<string>()
  for (const row of rows) {
    for (const parent of [row.parentDeviceId, row.forkedFrom, row.createdByDeviceId]) {
      if (parent !== undefined) {
        parents.add(parent)
      }
    }
  }
  return parents
}

/**
 * Rows this host minted for one peer that are no longer its credential: offers nobody redeemed past their TTL,
 * and rows a later one replaced.
 *
 * Why the peer's choice is proof: `lastSeenAt` is written when a socket authenticates and again when one closes,
 * so it does not order uses — a row whose connection is still open can look stale, and a row closed after its
 * replacement was minted can look newer. What cannot be argued with is which row the peer redeemed, so the newest
 * SIGHTED row in mint order is the credential and the older ones are spent. Mint order rather than `pairedAt`:
 * both are written by the same clock, but only one of them survives the clock going backwards.
 *
 * Why a parent is left alone: revoking a row also revokes rows minted from it — a phone paired through it, a
 * delegated mobile row. Retiring a spent credential must not spend anything else, so a row with children stays
 * and the owner keeps the only revoke that should cascade.
 *
 * Why the minted list decides membership: a peer's own pairing link is adopted into the index when it joins, and
 * that row is the owner's to keep, list and revoke — never the mesh's to retire.
 */
export function staleMeshRows(
  rows: readonly MeshDeviceRow[],
  peers: MeshPeerRows,
  now: number
): readonly MeshDeviceRow[] {
  const byId = new Map(rows.map((row) => [row.deviceId, row]))
  const candidates = peers.minted
    .map((id) => byId.get(id))
    .filter((row): row is MeshDeviceRow => row !== undefined && row.scope === 'runtime')
  if (candidates.length === 0) {
    return []
  }
  const parents = parentsOf(rows)
  const current = candidates.findLast((row) => row.lastSeenAt > 0) ?? null
  return candidates.filter((row) => {
    if (row.deviceId === current?.deviceId || parents.has(row.deviceId)) {
      return false
    }
    // Nothing redeemed yet: only its own TTL can clear it, and until then it is a link its recipient can scan.
    if (row.lastSeenAt === 0) {
      return row.offerExpiresAt !== undefined && row.offerExpiresAt <= now
    }
    return current !== null
  })
}

/**
 * Revokes the mesh's own spent device rows, and returns every id the peer index should now drop: the ones it
 * revoked, plus the ones the registry no longer has.
 *
 * Why the second group exists: an id whose row is gone is already revoked, but nothing else ever removed it from
 * the index, so the entry grew by a dead id per path that bypassed this sweep.
 *
 * Why per peer rather than one flat set: replacement is a relation between the rows minted for the same machine,
 * so the peer index — which is exactly that grouping, and which removal already trusts to revoke a whole set — is
 * the only thing that can answer which row replaced which.
 */
export function pruneMeshDeviceRows(
  server: MeshDeviceRowServer,
  peers: ReadonlyMap<string, MeshPeerRows>
): readonly string[] {
  const registry = server.getDeviceRegistry()
  if (!registry) {
    return []
  }
  const now = Date.now()
  const rows = registry.listDevices({ fresh: true })
  const present = new Set(rows.map((row) => row.deviceId))
  const dropped: string[] = []
  for (const peer of peers.values()) {
    for (const id of peer.all) {
      if (!present.has(id)) {
        dropped.push(id)
      }
    }
    for (const row of staleMeshRows(rows, peer, now)) {
      // Why removal is the fallback rather than the end: a full revoke settles queued asks and drops live sockets,
      // and a registry that refuses it still accepts the row deletion.
      let revoked = false
      try {
        revoked = server.revokeRuntimeAccess(row.deviceId)
      } catch {
        revoked = false
      }
      try {
        if (revoked || registry.removeDevice(row.deviceId)) {
          dropped.push(row.deviceId)
        }
      } catch {
        // Why one row does not end the sweep: the next pass retries it, and a throw here would end the whole
        // meeting.
      }
    }
  }
  return dropped
}
