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
  pairedAt: number
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
 * Why a sighted replacement is proof: `lastSeenAt` is written when a socket authenticates and again when one
 * closes, so it does not order uses — a row can look stale while a connection is still open on it, and a closed
 * one can look newer than the row that replaced it. What cannot be argued with is which row the peer chose: once
 * a minted row has been seen at all, the peer redeemed it, so the newer of the seen rows is the credential and the
 * older ones are spent. That comparison never reads `lastSeenAt`.
 *
 * Why a parent is left alone: revoking a row also revokes rows minted from it — a phone paired through it, a
 * delegated mobile row. Retiring a spent credential must not spend anything else, so a row with children stays
 * and the owner keeps the only revoke that should cascade.
 *
 * Why `minted` decides membership: a peer's own pairing link is adopted into the index when it joins, and that row
 * is the owner's to keep, list and revoke — never the mesh's to retire.
 */
export function staleMeshRows(
  rows: readonly MeshDeviceRow[],
  minted: ReadonlySet<string>,
  now: number
): readonly MeshDeviceRow[] {
  const candidates = rows.filter((row) => row.scope === 'runtime' && minted.has(row.deviceId))
  if (candidates.length === 0) {
    return []
  }
  const parents = parentsOf(rows)
  const seen = candidates.filter((row) => row.lastSeenAt > 0)
  const current = seen.reduce<MeshDeviceRow | null>(
    (newest, row) => (newest === null || row.pairedAt > newest.pairedAt ? row : newest),
    null
  )
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
 * Revokes the mesh's own spent device rows and returns the ids it dropped.
 *
 * Why per peer rather than one flat set: replacement is a relation between the rows minted for the same machine,
 * so the peer index — which is exactly that grouping, and which removal already trusts to revoke a whole set — is
 * the only thing that can answer which row replaced which.
 */
export function pruneMeshDeviceRows(
  server: MeshDeviceRowServer,
  peers: ReadonlyMap<string, { minted: readonly string[]; all: readonly string[] }>
): readonly string[] {
  const registry = server.getDeviceRegistry()
  if (!registry) {
    return []
  }
  const now = Date.now()
  const byId = new Map(registry.listDevices({ fresh: true }).map((row) => [row.deviceId, row]))
  const pruned: string[] = []
  for (const peer of peers.values()) {
    const own = peer.all
      .map((id) => byId.get(id))
      .filter((row): row is MeshDeviceRow => row !== undefined)
    for (const row of staleMeshRows(own, new Set(peer.minted), now)) {
      try {
        if (server.revokeRuntimeAccess(row.deviceId) || registry.removeDevice(row.deviceId)) {
          pruned.push(row.deviceId)
        }
      } catch {
        // Why one row does not end the sweep: the next pass retries it, and a throw here would end the whole
        // meeting.
      }
    }
  }
  return pruned
}
