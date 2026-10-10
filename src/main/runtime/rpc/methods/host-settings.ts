import { ApplyHostSettingsReplicationParams } from '../../../../shared/rpc-contract/host-settings-params'
import {
  applyHostSettingsReplication,
  getHostSettingsReplication
} from '../../../host-sync/host-settings-replication-host'
import { defineMethod } from '../core'

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
    handler: (params) => applyHostSettingsReplication(params.payload)
  }),
  defineMethod({
    name: 'hostSettings.replicationState',
    permission: 'workspace',
    params: null,
    // Why separate from `status.get`: a host that has never synced must be able to say so without the
    // main having to infer it from an empty credential list, which reads as "you have no integrations".
    handler: () => getHostSettingsReplication()
  })
]
