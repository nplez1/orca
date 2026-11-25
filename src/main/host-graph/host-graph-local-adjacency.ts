import type { HostGraphAdjacency } from '../../shared/host-graph/host-graph-contract'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/catalog/runtime-environment-registry-root'
import { loadTrustedHostKeys } from '../ssh/host-keys/ssh-host-key-store'
import { getRegisteredSshState, listRegisteredSshTargets } from '../ssh/targets/ssh-target-registry'
import { buildOwnAdjacency, type HostGraphOwnEdgeSources } from './host-graph-own-edges'
import { readSelfMachineRef, selfLabel } from './host-graph-self-identity'

/**
 * This machine's own adjacency, assembled from the real stores.
 *
 * Why every read degrades to empty: a host that cannot list its own targets must still answer, or one
 * unreadable store removes it from every peer's fleet instead of showing it with no edges.
 */
export async function readLocalAdjacency(): Promise<HostGraphAdjacency> {
  const readSafely = async <T>(read: () => T | Promise<T>, fallback: T): Promise<T> => {
    try {
      return await read()
    } catch {
      return fallback
    }
  }
  const root = getRuntimeEnvironmentRegistryRoot()
  const [environments, sshTargets, trustedHostKeys] = await Promise.all([
    readSafely<HostGraphOwnEdgeSources['environments']>(() => listEnvironments(root), []),
    readSafely<HostGraphOwnEdgeSources['sshTargets']>(() => listRegisteredSshTargets(), []),
    readSafely<HostGraphOwnEdgeSources['trustedHostKeys']>(() => loadTrustedHostKeys(), [])
  ])
  const connectedSshTargetIds = sshTargets
    .filter((target) => getRegisteredSshState(target.id)?.status === 'connected')
    .map((target) => target.id)
  return buildOwnAdjacency({
    now: Date.now(),
    // Why the host's own keys: a peer names this machine by the pairing key it recorded, so without
    // them this host cannot recognise its own row in the fleet it asks about.
    self: { label: selfLabel(), ...readSelfMachineRef(root) },
    environments,
    sshTargets,
    trustedHostKeys,
    connectedSshTargetIds
  })
}
