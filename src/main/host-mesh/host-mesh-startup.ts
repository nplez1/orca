import type { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import { startHostMeshAutoSync } from './host-mesh-auto-sync'
import { configureHostMeshRuntimeFromApp } from './host-mesh-runtime-deps'
import { migrateHostMeshFromPairings, syncHostMesh } from './host-mesh-runtime'

/**
 * Everything the group needs installed on the launch path, behind one call.
 *
 * Why one call rather than two statements in the launcher: the launcher is upstream's file and its order is
 * the contract, so a fork wants a single line in it — one that says what it does, not how. Both steps belong
 * to the same moment: the server must exist before the mesh can answer, and the upgrade step must run once,
 * before anything asks for a snapshot.
 */
export function installHostMeshRuntime(runtimeRpc: OrcaRuntimeRpcServer): void {
  configureHostMeshRuntimeFromApp(runtimeRpc) // Offers mint lazily, so the server need only exist.
  migrateHostMeshFromPairings()
  // Why here: the mesh has to converge on a machine whose Settings nobody opened, so its cadence cannot live in a
  // surface. Nothing to join means the pass returns immediately, so a host in no group costs one read a minute.
  startHostMeshAutoSync({
    run: async () => {
      const snapshot = await syncHostMesh()
      return { reached: snapshot.lastPassReached ?? 0, members: snapshot.members.length }
    }
  })
}
