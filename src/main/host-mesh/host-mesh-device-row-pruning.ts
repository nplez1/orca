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
}

/** The two things a revoking sweep needs from the server, so a caller only has to be structurally that. */
export type MeshDeviceRowServer = Pick<HostMeshRuntimeServer, 'revokeRuntimeAccess'> & {
  getDeviceRegistry: () => {
    listDevices: (options?: { fresh?: boolean }) => readonly MeshDeviceRow[]
    removeDevice: (deviceId: string) => boolean
  } | null
}

/**
 * Rows one peer has minted here that are no longer a credential: offers it never redeemed, and rows a later
 * one replaced.
 *
 * Why "replaced" is proven rather than assumed: a retry mints a new row each time, Settings counts every row a
 * peer was ever seen from as a live link, and nothing retires the old one. A row is spent when a newer row for
 * the same machine has been sighted — the peer authenticated with it — and this row has produced no sighting
 * since that successor was minted. That is a fact about use, not an age, so the very next pass drops it: no grace
 * window, and a row a peer is still using survives however old it is, because using it writes a later sighting.
 *
 * Why an unexpired offer stays: it is still a link its recipient can scan, so only its own TTL can clear it.
 */
export function staleMeshRows(
  rows: readonly MeshDeviceRow[],
  now: number
): readonly MeshDeviceRow[] {
  const sighted = rows.filter((row) => row.scope === 'runtime' && row.lastSeenAt > 0)
  return rows
    .filter((row) => row.scope === 'runtime')
    .filter((row) =>
      row.lastSeenAt === 0
        ? row.offerExpiresAt !== undefined && row.offerExpiresAt <= now
        : sighted.some((other) => other.pairedAt > row.pairedAt && row.lastSeenAt < other.pairedAt)
    )
}

/**
 * Revokes the mesh's own spent device rows and returns the ids it dropped.
 *
 * Why per peer rather than one flat set: supersession is a relation between the rows minted for the same
 * machine, so the peer index — which is exactly that grouping, and which removal already trusts to revoke a
 * whole set — is the only thing that can answer which row is current.
 *
 * Why only these rows: an owner's hand-minted pairing link is not in the peer index, and revoking a link someone
 * is holding a QR code for is not this sweep's to do.
 */
export function pruneMeshDeviceRows(
  server: MeshDeviceRowServer,
  peers: ReadonlyMap<string, readonly string[]>
): readonly string[] {
  const registry = server.getDeviceRegistry()
  if (!registry) {
    return []
  }
  const now = Date.now()
  const byId = new Map(registry.listDevices({ fresh: true }).map((row) => [row.deviceId, row]))
  const pruned: string[] = []
  for (const ids of peers.values()) {
    const own = ids
      .map((id) => byId.get(id))
      .filter((row): row is MeshDeviceRow => row !== undefined)
    for (const row of staleMeshRows(own, now)) {
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
