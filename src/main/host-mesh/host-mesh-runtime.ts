import type {
  HostMeshDriver,
  HostMeshDriverDeps,
  HostMeshJoinOutcome,
  HostMeshRpcService,
  HostMeshSnapshot
} from './host-mesh-driver-contract'
import type { HostMeshSettings } from '../../shared/host-mesh/host-mesh-admission'

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

export function joinHostMesh(environmentId: string): Promise<HostMeshJoinOutcome> {
  return requireDriver().join(environmentId)
}

export function syncHostMesh(): Promise<HostMeshSnapshot> {
  return requireDriver().sync()
}

export function removeHostMeshMember(hostKey: string): Promise<HostMeshSnapshot> {
  return requireDriver().removeMember(hostKey)
}

export function leaveHostMeshGroup(): Promise<HostMeshSnapshot> {
  return requireDriver().leave()
}

export function updateHostMeshSettings(
  patch: Partial<HostMeshSettings>
): Promise<HostMeshSnapshot> {
  return requireDriver().updateSettings(patch)
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
