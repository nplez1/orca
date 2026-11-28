import type { HostMeshRuntimeServer } from './host-mesh-runtime-deps'

/** How long a superseded row may keep being counted before the sweep drops it. */
export const SUPERSEDED_ROW_GRACE_MS = 24 * 60 * 60 * 1000

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
}

/** The two things a revoking sweep needs from the server, so a caller only has to be structurally that. */
export type MeshDeviceRowServer = Pick<HostMeshRuntimeServer, 'revokeRuntimeAccess'> & {
  getDeviceRegistry: () => {
    listDevices: (options?: { fresh?: boolean }) => readonly MeshDeviceRow[]
    removeDevice: (deviceId: string) => boolean
  } | null
}

/**
 * Rows one peer has minted here that are no longer its credential: offers it never redeemed, and rows a later
 * one superseded.
 *
 * Why superseded rows are the bulk of it: a retry mints a new row each time, the peer redeems it and the old
 * row stays — seen, so never "expired", so counted as a live link for good. Left alone, a peer that re-joins
 * once per outage ends up with one bearer credential per retry, and an owner reading forty-five of them cannot
 * tell that from a fleet that size.
 *
 * Why the grace: a token in use refreshes `lastSeenAt` on every connect, while a peer that holds two
 * environments against this host refreshes both. Only a row nobody has used in a day is provably not in use,
 * so the newest row is kept and the rest wait out the grace.
 */
export function staleMeshRows(
  rows: readonly MeshDeviceRow[],
  now: number
): readonly MeshDeviceRow[] {
  const live = rows.filter((row) => row.scope === 'runtime')
  const newestSeenAt = live.reduce((newest, row) => Math.max(newest, row.lastSeenAt), 0)
  return live.filter((row) =>
    row.lastSeenAt === 0
      ? // An unexpired offer is still a link its recipient can scan, so only its own TTL can clear it.
        row.offerExpiresAt !== undefined && row.offerExpiresAt <= now
      : row.lastSeenAt < newestSeenAt && now - row.lastSeenAt > SUPERSEDED_ROW_GRACE_MS
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
