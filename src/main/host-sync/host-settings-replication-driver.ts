import { getAppEnvironment } from '../../shared/app-environment'
import {
  HOST_SETTINGS_REPLICATION_RUNTIME_CAPABILITY,
  type HostSettingsReplicationApplyResult
} from '../../shared/host-settings-replication'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { resolveEnvironmentPairingOffer } from '../../shared/runtime-environment-store'
import { HOST_SETTINGS_CREDENTIAL_PORTS } from './host-settings-credential-ports'
import { setReplicatedCredentialChangeListener } from './host-settings-replication-service'
import {
  createHostSettingsReplicationSync,
  type HostSettingsReplicationSync
} from './host-settings-replication-sync'

/** A status read is a round trip; this is the ceiling before a push gives up on the probe. */
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000

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
    const resolvePairing = (environmentId: string) =>
      resolveEnvironmentPairingOffer(getAppEnvironment().getPath('userData'), environmentId)

    driver = createHostSettingsReplicationSync({
      ports: HOST_SETTINGS_CREDENTIAL_PORTS,
      resolvePairing,
      sendRequest: (pairing, method, params, timeoutMs) =>
        sendRemoteRuntimeRequest<HostSettingsReplicationApplyResult>(
          pairing,
          method,
          params,
          timeoutMs
        ),
      // Why a probe rather than only the host's refusal: the capability is what this wire's rules
      // require a client to check, and it keeps a host that cannot receive a payload from being sent
      // one. Not cached — a host can be upgraded between connections, and a stale "no" would outlive
      // the reason for it. Pushes are debounced, so this is one status read per host per burst.
      supportsReplication: async (environmentId) => {
        try {
          const response = await sendRemoteRuntimeRequest(
            resolvePairing(environmentId),
            'status.get',
            undefined,
            CAPABILITY_PROBE_TIMEOUT_MS
          )
          if (!response.ok) {
            return false
          }
          const capabilities = readCapabilities(response.result)
          return capabilities.includes(HOST_SETTINGS_REPLICATION_RUNTIME_CAPABILITY)
        } catch {
          // A probe that cannot run is not evidence the host cannot receive; the refusal path decides.
          return true
        }
      }
    })
    setReplicatedCredentialChangeListener(() => driver?.notifyChanged())
  }
  return driver
}

function readCapabilities(status: unknown): string[] {
  if (typeof status !== 'object' || status === null) {
    return []
  }
  const capabilities: unknown = 'capabilities' in status ? status.capabilities : undefined
  return Array.isArray(capabilities)
    ? capabilities.filter((entry): entry is string => typeof entry === 'string')
    : []
}
