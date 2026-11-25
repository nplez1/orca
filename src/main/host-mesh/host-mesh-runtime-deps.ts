import type { KnownRuntimeEnvironment } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import { getPreferredPairedRuntimeConnection } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  addOrUpdateEnvironmentFromPairingCode,
  parseRemotePairingCode,
  removeEnvironment,
  resolveEnvironmentPairingOffer
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { pairedRuntimeConnectionFromOffer } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { sendRemoteRuntimeRequestOnSocket } from '../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { orcaHostKeyOf } from '../host-graph/host-graph-self-identity'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { loadOrCreateE2EEKeypair } from '../runtime/rpc/server/pairing/e2ee-keypair'
import {
  createOwnerPairingOffer,
  type PairingOfferServer
} from '../runtime/rpc/server/pairing/pairing-offer-requests'
import type { HostMeshDriverDeps } from './host-mesh-driver-contract'
import { createHostMeshDriver } from './host-mesh-driver'
import { createHostMeshRpcService } from './host-mesh-rpc-service'
import { __installHostMeshDriver, configureHostMeshRuntime } from './host-mesh-runtime'
import { createHostMeshStore } from './host-mesh-store'

/**
 * The one place the mesh is handed the real app: the canonical pairing store, this profile's own keypair,
 * the runtime server that mints offers and revokes devices, and the socket that reaches a member.
 *
 * Why the server is an argument and every import here is a leaf: `host-mesh-runtime` is loaded by the
 * runtime server's own dispatch, so a module that imported the server class back would close a cycle
 * through the class that is being constructed when this runs. The type below is structural for the same
 * reason — it is a shape this module needs, not a second name for the server.
 */

/** How long one call to a member may take. The driver records the failure as a link state, not a hang. */
const SEND_TIMEOUT_MS = 20_000

export type HostMeshRuntimeServer = PairingOfferServer & {
  /** The full revoke: settles queued asks and drops live sockets, not only the row. */
  revokeRuntimeAccess: (deviceId: string) => boolean
  getDeviceRegistry: () => { removeDevice: (deviceId: string) => boolean } | null
}

/**
 * Why it swallows: a mesh that cannot be wired leaves Settings showing "this build cannot reach the host
 * group", which is true and recoverable; refusing to start the app over it is not.
 */
export function configureHostMeshRuntimeFromApp(server: HostMeshRuntimeServer): void {
  try {
    // Why here rather than at module import: nothing should load the protocol until a running app can
    // actually answer, and a build that never calls this keeps reporting the group as unavailable.
    __installHostMeshDriver(createHostMeshDriver, createHostMeshRpcService)
    configureHostMeshRuntime(depsFromApp(server))
  } catch (error) {
    console.warn('[host-mesh] the host group is unavailable in this build:', error)
  }
}

function depsFromApp(server: HostMeshRuntimeServer): HostMeshDriverDeps {
  // The same canonical path pairing writes to: the group's state must live beside the pairings it names.
  const userDataPath = getCanonicalUserDataPath()
  const store = createHostMeshStore({ userDataPath })

  return {
    userDataPath,
    now: () => Date.now(),
    ownKeypair: () => loadOrCreateE2EEKeypair(userDataPath),
    // No `grantDesktopControl`: an introduced member gets `workspace` and nothing more.
    mintRuntimeOffer: async () => {
      const offer = await createOwnerPairingOffer(server, { scope: 'runtime' })
      if (!offer.available) {
        throw new Error(offer.reason)
      }
      return { offerUrl: offer.pairingUrl, deviceId: offer.deviceId }
    },
    redeemOffer: async (offerUrl, expectedHostKey) => {
      const offer = await parseRemotePairingCode(userDataPath, offerUrl)
      // Refused before any environment record exists for it: a box names the machine it should have come
      // from, and an offer minted by any other machine is not the box this host was promised.
      if (orcaHostKeyOf(offer.publicKeyB64) !== expectedHostKey) {
        throw new Error('offer-not-from-expected-minter')
      }
      const outcome = await addOrUpdateEnvironmentFromPairingCode(userDataPath, {
        // Nobody is present to type a name, and the host key is the one identifier two hosts cannot share.
        name: `Mesh host ${orcaHostKeyOf(offer.publicKeyB64).slice(0, 8)}`,
        pairingCode: offerUrl
      })
      const publicKey = getPreferredPairedRuntimeConnection(outcome.environment).hostPublicKeyB64
      if (!publicKey) {
        throw new Error('paired_environment_without_host_key')
      }
      return {
        environmentId: outcome.environment.id,
        hostKey: orcaHostKeyOf(publicKey),
        label: outcome.environment.name
      }
    },
    // Why fired and not awaited: the dep is called from a synchronous position, and an environment with
    // independent SSH access legitimately refuses removal — the member is still cut on the inbound side.
    forgetEnvironment: (selector) => {
      void removeEnvironment(userDataPath, selector).catch((error: unknown) => {
        console.debug('[host-mesh] could not forget the environment', selector, error)
      })
    },
    // Why the peer index and not the pairing rows: another build may rewrite the device registry and drop
    // the fields that would have named this member's row.
    forgetDevice: (hostKey) => {
      for (const deviceRowId of store.readPeerIndex().get(hostKey)?.deviceRowIds ?? []) {
        // The registry's plain remove is the fallback for a row recorded under another scope, which the
        // runtime-scope revoke refuses rather than deleting.
        if (!server.revokeRuntimeAccess(deviceRowId)) {
          server.getDeviceRegistry()?.removeDevice(deviceRowId)
        }
      }
    },
    environmentIdForHostKey: (hostKey) => environmentForHostKey(userDataPath, hostKey)?.id ?? null,
    labelForHostKey: (hostKey) => environmentForHostKey(userDataPath, hostKey)?.name ?? null,
    send: async <T>(environmentId: string, method: string, params: unknown): Promise<T> => {
      const offer = await resolveEnvironmentPairingOffer(userDataPath, environmentId)
      const response = await sendRemoteRuntimeRequestOnSocket<T>(
        pairedRuntimeConnectionFromOffer(offer),
        method,
        params,
        SEND_TIMEOUT_MS
      )
      // A code and not the payload: the driver records a reason, and a peer's own words belong in its log.
      if (!response.ok) {
        throw new Error(response.error.code)
      }
      return response.result
    },
    settings: () => store.readSettings(),
    saveSettings: (settings) => store.writeSettings(settings)
  }
}

/**
 * Why a scan and a synchronous read: the driver asks "which environment reaches this host" from inside a
 * snapshot, and the pairing store is the authority — the mesh store's index is a hint that removal cannot
 * afford to trust alone. Reads are safe here because every store write is a rename, so a read is either
 * the old file or the new one.
 */
function environmentForHostKey(
  userDataPath: string,
  hostKey: string
): KnownRuntimeEnvironment | null {
  try {
    return (
      listEnvironments(userDataPath).find((environment) => {
        if (environment.endpoints.length === 0) {
          return false
        }
        const publicKey = getPreferredPairedRuntimeConnection(environment).hostPublicKeyB64
        return publicKey !== undefined && orcaHostKeyOf(publicKey) === hostKey
      }) ?? null
    )
  } catch {
    // An unreadable store is "no environment for this host", not a reason to refuse the whole snapshot.
    return null
  }
}
