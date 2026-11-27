import type { HostMeshRuntimeServer } from './host-mesh-runtime-deps'

/**
 * Revokes this host's own runtime offers that expired without anyone redeeming them.
 *
 * Why revoke and not just filter: the row is still a credential to every reader of the registry, which is why
 * Settings counts it as an active link. An offer past its own `offerExpiresAt` can no longer pair anything, so
 * removing it changes no capability and stops the count from describing a mesh nobody can join.
 *
 * Why it lives apart from the dependency wiring: it is a sweep over someone else's table, and that is a different
 * thing to read than the mesh's own dependencies.
 */
export function pruneExpiredMeshOffers(
  server: HostMeshRuntimeServer,
  mintedHere: ReadonlySet<string>
): readonly string[] {
  const registry = server.getDeviceRegistry()
  if (!registry) {
    return []
  }
  const now = Date.now()
  const pruned: string[] = []
  for (const device of registry.listDevices({ fresh: true })) {
    if (
      device.scope !== 'runtime' ||
      device.lastSeenAt !== 0 ||
      device.offerExpiresAt === undefined ||
      device.offerExpiresAt > now ||
      // Why only the mesh's own rows: an owner's hand-minted pairing offer expires on the same TTL and is theirs to
      // clear, so the pass must not sweep a table it did not write.
      !mintedHere.has(device.deviceId)
    ) {
      continue
    }
    try {
      if (server.revokeRuntimeAccess(device.deviceId) || registry.removeDevice(device.deviceId)) {
        pruned.push(device.deviceId)
      }
    } catch {
      // Why one row does not end the sweep: the next pass retries it, and a throw here would end the whole meeting.
    }
  }
  return pruned
}
