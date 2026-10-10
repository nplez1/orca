import { getAppEnvironment } from '../../shared/app-environment'
import type { HostSettingsReplicationApplyResult } from '../../shared/host-settings-replication'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { resolveEnvironmentPairingOffer } from '../../shared/runtime-environment-store'
import { HOST_SETTINGS_CREDENTIAL_PORTS } from './host-settings-credential-ports'
import { setReplicatedCredentialChangeListener } from './host-settings-replication-service'
import {
  createHostSettingsReplicationSync,
  type HostSettingsReplicationSync
} from './host-settings-replication-sync'

let driver: HostSettingsReplicationSync | null = null

/**
 * The process-wide replication driver.
 *
 * Why lazy: it needs the app environment to resolve a pairing offer, and the hooks that feed it — the
 * connection diagnostics and the credential sites — are imported by modules that load before the app
 * environment exists. Nothing here runs until a paired host connects.
 *
 * Why a module singleton rather than an injected dependency: the two hooks are in unrelated modules (an
 * IPC connection registry and eight credential sites), and threading one object through all of them
 * would be a bigger change than the feature.
 */
export function getHostSettingsReplicationSync(): HostSettingsReplicationSync {
  if (driver === null) {
    driver = createHostSettingsReplicationSync({
      ports: HOST_SETTINGS_CREDENTIAL_PORTS,
      resolvePairing: (environmentId) =>
        resolveEnvironmentPairingOffer(getAppEnvironment().getPath('userData'), environmentId),
      sendRequest: (pairing, method, params, timeoutMs) =>
        sendRemoteRuntimeRequest<HostSettingsReplicationApplyResult>(
          pairing,
          method,
          params,
          timeoutMs
        )
    })
    setReplicatedCredentialChangeListener(() => driver?.notifyChanged())
  }
  return driver
}
