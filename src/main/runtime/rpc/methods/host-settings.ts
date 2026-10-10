import { ApplyHostSettingsReplicationParams } from '../../../../shared/rpc-contract/host-settings-params'
import {
  applyHostSettingsReplication,
  getHostSettingsReplication
} from '../../../host-sync/host-settings-replication-host'
import { createFileHostSettingsReplicationHoldings } from '../../../host-sync/host-settings-replication-holdings'
import { defineMethod } from '../core'

// Why resolved once per process: it names a file under userData, and rebuilding it per request would
// re-resolve the app environment on every push for no gain.
let holdings: ReturnType<typeof createFileHostSettingsReplicationHoldings> | null = null

function replicationHoldings(): ReturnType<typeof createFileHostSettingsReplicationHoldings> {
  holdings ??= createFileHostSettingsReplicationHoldings()
  return holdings
}

/**
 * Settings and credential replication, as a paired main drives it on this host.
 *
 * Why `accounts-admin`: receiving another machine's provider credentials is the same act as adding an
 * account here, and that permission is already granted to a paired desktop while a phone is refused —
 * which is exactly the trust boundary the design asks for. A phone holding a pairing token must not be
 * able to write credentials onto a host.
 */
export const HOST_SETTINGS_METHODS = [
  defineMethod({
    name: 'hostSettings.applyReplication',
    permission: 'accounts-admin',
    params: ApplyHostSettingsReplicationParams,
    handler: (params, ctx) =>
      applyHostSettingsReplication(params.payload, {
        holdings: replicationHoldings(),
        // Why this identity and not the socket's: it is the paired caller the transport authenticated
        // and durable saved state can name, so it is what a host can pin "the main" to. Absent for an
        // in-process owner, which is the user at this machine and always allowed.
        ...(ctx.authenticatedCallerFingerprint === undefined
          ? {}
          : { callerFingerprint: ctx.authenticatedCallerFingerprint })
      })
  }),
  defineMethod({
    name: 'hostSettings.replicationState',
    permission: 'workspace',
    params: null,
    // Why separate from `status.get`: a host that has never synced must be able to say so without the
    // main having to infer it from an empty credential list, which reads as "you have no integrations".
    handler: () => getHostSettingsReplication(replicationHoldings())
  })
]
