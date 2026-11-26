import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { observeHostGraphEnvironmentConnection } from './host-graph-connection-state'
import { invalidateHostGraphSnapshot } from './host-graph-driver'

/**
 * Tells the fleet that one connection changed: remember the state, and let the next read re-ask.
 *
 * Why one call: the upstream connection-observation file is a two-line hook in a fork's ideal world, and the
 * pair of these has to happen together — an observation with no invalidation leaves a stale snapshot.
 */
export function notifyHostGraphOfConnectionChange(args: {
  environmentId: string
  transportGeneration: number
  diagnostics: RemoteRuntimeSharedConnectionDiagnostics
}): void {
  observeHostGraphEnvironmentConnection({
    environmentId: args.environmentId,
    transportGeneration: args.transportGeneration,
    state: args.diagnostics.state
  })
  invalidateHostGraphSnapshot()
}
