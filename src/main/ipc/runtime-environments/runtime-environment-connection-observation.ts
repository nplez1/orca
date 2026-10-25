import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { getHostSettingsReplicationSync } from '../../host-sync/host-settings-replication-driver'
import { publishRuntimeEnvironmentDiagnostics } from './runtime-environment-diagnostics-broadcast'

/**
 * Everything the main does when a paired host's connection diagnostics change.
 *
 * Why one seam: this is the only place the main learns that host's connection state, so a `ready`
 * state on a new transport generation is exactly "a new host just attached" — the moment its
 * credentials have to arrive for its task pane to work. Broadcasting it and telling host-settings
 * replication are two reactions to that one fact, and keeping them together means a later edit
 * cannot report the state to renderers while leaving replication behind.
 */
export function publishConnectionDiagnostics(args: {
  environmentId: string
  transportGeneration: number
  diagnostics: RemoteRuntimeSharedConnectionDiagnostics
}): void {
  getHostSettingsReplicationSync().observeConnection({
    environmentId: args.environmentId,
    transportGeneration: args.transportGeneration,
    state: args.diagnostics.state
  })
  publishRuntimeEnvironmentDiagnostics(args)
}
