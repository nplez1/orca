import type {
  HostMeshDriver,
  HostMeshDriverDeps,
  HostMeshJoinOutcome,
  HostMeshMigrationOutcome,
  HostMeshRpcService,
  HostMeshSnapshot
} from './host-mesh-driver-contract'
import type { HostMeshSettings } from '../../shared/host-mesh/host-mesh-admission'
import { nudgeHostMeshSync } from './host-mesh-auto-sync'

/**
 * The one place the mesh is reachable from, for the two callers that need it: the renderer's IPC handlers
 * and the RPC context peers call.
 *
 * Why a configured singleton: the driver needs Electron paths, the pairing service, the environment store
 * and a live transport, and each of those is built once at startup. Passing them through every layer would
 * mean four copies of the same wiring; `configureHostMeshRuntime` is called once and both faces read it.
 */

let deps: HostMeshDriverDeps | null = null
let driver: HostMeshDriver | null = null

export function configureHostMeshRuntime(next: HostMeshDriverDeps): void {
  deps = next
  driver = null
}

/** Throws rather than silently reporting an empty group, which would read as "you have no members". */
function requireDriver(): HostMeshDriver {
  if (!deps) {
    throw new Error('host_mesh_runtime_unavailable')
  }
  driver ??= buildDriver(deps)
  return driver
}

export function readHostMeshSnapshot(): Promise<HostMeshSnapshot> {
  return requireDriver().snapshot()
}

/**
 * Runs the upgrade step once, at startup.
 *
 * Why here rather than in the RPC surface: it writes a group into the store, and an RPC-reachable call could
 * be driven by a peer. Startup is the only moment at which "the owner just installed this build" is true.
 */
export function migrateHostMeshFromPairings(): HostMeshMigrationOutcome {
  try {
    return requireDriver().migrateFromPairings()
  } catch {
    // A mesh that cannot be built yet must not stop the app from starting: the next launch retries.
    return { kind: 'nothing-to-group' }
  }
}

export function joinHostMesh(environmentId: string): Promise<HostMeshJoinOutcome> {
  return requireDriver().join(environmentId)
}

export function syncHostMesh(): Promise<HostMeshSnapshot> {
  return requireDriver().sync()
}

export function removeHostMeshMember(hostKey: string): Promise<HostMeshSnapshot> {
  return requireDriver().removeMember(hostKey)
}

/** Renames a machine for the whole group; every other host picks the name up on its next pass. */
export function renameHostMeshMember(hostKey: string, label: string): Promise<HostMeshSnapshot> {
  return requireDriver().renameMember(hostKey, label)
}

export function leaveHostMeshGroup(): Promise<HostMeshSnapshot> {
  return requireDriver().leave()
}

/** A paired machine's connection came up: a technical refusal is worth retrying at once. */
export function noteHostMeshConnectionChange(): void {
  if (!deps) {
    return
  }
  requireDriver().noteConnectionChange()
  nudgeHostMeshSync()
}

export async function updateHostMeshSettings(
  patch: Partial<HostMeshSettings>
): Promise<HostMeshSnapshot> {
  const snapshot = await requireDriver().updateSettings(patch)
  // Why a nudge and not a wait: turning the switch on is the moment a fleet can converge, and the pass it needs is
  // the same background one a connection change triggers.
  if (snapshot.settings.enabled) {
    nudgeHostMeshSync()
  }
  return snapshot
}

export function hostMeshRpcService(): HostMeshRpcService {
  if (!deps) {
    throw new Error('host_mesh_runtime_unavailable')
  }
  return buildRpcService(deps)
}

// For wiring that must run in tests and non-mesh builds, where throwing at startup would refuse every call.
export function hostMeshRpcServiceIfAvailable(): HostMeshRpcService | null {
  try {
    return hostMeshRpcService()
  } catch {
    return null
  }
}

// Filled in by the driver module; declared here so the two layers above can be built against the names.
let buildDriver: (deps: HostMeshDriverDeps) => HostMeshDriver = () => {
  throw new Error('host_mesh_driver_not_wired')
}
let buildRpcService: (deps: HostMeshDriverDeps) => HostMeshRpcService = () => {
  throw new Error('host_mesh_driver_not_wired')
}

export function __installHostMeshDriver(
  factory: (deps: HostMeshDriverDeps) => HostMeshDriver,
  rpcFactory: (deps: HostMeshDriverDeps) => HostMeshRpcService
): void {
  buildDriver = factory
  buildRpcService = rpcFactory
  driver = null
}
