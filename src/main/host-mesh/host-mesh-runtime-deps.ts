import type { KnownRuntimeEnvironment } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import { getPreferredPairedRuntimeConnection } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  addOrUpdateEnvironmentFromPairingCode,
  parseRemotePairingCode,
  removeEnvironment,
  renameEnvironment,
  resolveEnvironmentPairingOffer
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  listEnvironments,
  uniqueEnvironmentName
} from '../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { publishRuntimeEnvironmentCatalogChanged } from '../ipc/runtime-environments/catalog/runtime-environment-catalog-broadcast'
import { pairedRuntimeConnectionFromOffer } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { sendRemoteRuntimeRequestOnSocket } from '../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { orcaHostKeyOf, selfLabel } from '../host-graph/host-graph-self-identity'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { loadOrCreateE2EEKeypair } from '../runtime/rpc/server/pairing/e2ee-keypair'
import {
  createOwnerPairingOffer,
  type PairingOfferServer
} from '../runtime/rpc/server/pairing/pairing-offer-requests'
import {
  HOST_MESH_MAX_LABEL_CHARS,
  HOST_MESH_OFFER_TTL_MS,
  hostMeshPlaceholderName
} from '../../shared/host-mesh/host-mesh-contract'
import type { HostMeshDriverDeps } from './host-mesh-driver-contract'
import { createHostMeshWriteLock } from './host-mesh-write-lock'
import { createHostMeshDriver } from './host-mesh-driver'
import { createHostMeshRpcService } from './host-mesh-rpc-service'
import { nudgeHostMeshSync } from './host-mesh-auto-sync'
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

/**
 * The reach the pairing this host already holds for a member uses, so an offer back cannot widen exposure.
 *
 * Why this matters: minting a runtime offer for network reach calls `ensureNetworkExposure`, which the design note
 * records as irreversible. That was harmless when only an owner's join minted one; the scheduled pass mints on its
 * own, so a host paired over loopback (an SSH tunnel, another account on the same machine) would be opened to the
 * network by a background loop with no owner action. Handing back an offer at the reach the pairing already uses
 * keeps the pair possible and the exposure unchanged.
 */
async function reachOfExistingPairing(
  environmentId: string
): Promise<{ address: string; reach: 'this-computer' } | Record<string, never>> {
  if (environmentId === '') {
    return {}
  }
  try {
    const offer = await resolveEnvironmentPairingOffer(getCanonicalUserDataPath(), environmentId)
    const host = new URL(offer.endpoint).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
      ? { address: host, reach: 'this-computer' }
      : {}
  } catch {
    // Why the permissive branch: an endpoint this build cannot read is not a reason to refuse the pair, and the
    // existing pairing already reaches that machine, so its exposure is already what it is.
    return {}
  }
}

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
    // One writer at a time across the driver and the peer-facing service: they share this store.
    lock: createHostMeshWriteLock(),
    ownKeypair: () => loadOrCreateE2EEKeypair(userDataPath),
    // No `grantDesktopControl`: an introduced member gets `workspace` and nothing more.
    mintRuntimeOffer: async ({ environmentId }) => {
      const offer = await createOwnerPairingOffer(
        server,
        { scope: 'runtime', ...(await reachOfExistingPairing(environmentId)) },
        undefined,
        undefined,
        {
          // Why fresh: upstream reuses one unused pending runtime offer per (grants, creator), so a pass that mints
          // for two machines would hand both the same device row — one identity, and ejecting one would cut the
          // other's link for good. A row per recipient is the only shape removal can revoke truthfully.
          fresh: true,
          // Why a TTL as well: a refused or unreachable member is retried, and without an expiry each attempt would
          // leave a live credential with no end. The offer's own lifetime is the bound.
          offerTtlMs: HOST_MESH_OFFER_TTL_MS
        }
      )
      if (!offer.available) {
        throw new Error(offer.reason)
      }
      return { offerUrl: offer.pairingUrl, deviceId: offer.deviceId }
    },
    redeemOffer: async (offerUrl, expectedHostKey, label) => {
      const offer = await parseRemotePairingCode(userDataPath, offerUrl)
      // Refused before any environment record exists for it: a box names the machine it should have come
      // from, and an offer minted by any other machine is not the box this host was promised.
      if (orcaHostKeyOf(offer.publicKeyB64) !== expectedHostKey) {
        throw new Error('offer-not-from-expected-minter')
      }
      const outcome = await addOrUpdateEnvironmentFromPairingCode(userDataPath, {
        // Nobody is present to type a name, so the machine that minted the offer names itself; the host key is only
        // the fallback for a minter too old to send one. Two machines genuinely called the same thing get a suffix
        // rather than an error, because a refused redemption would leave the pair half-joined.
        name: uniqueEnvironmentName(
          listEnvironments(userDataPath),
          usablePeerLabel(label, expectedHostKey)
        ),
        pairingCode: offerUrl
      })
      const publicKey = getPreferredPairedRuntimeConnection(outcome.environment).hostPublicKeyB64
      if (!publicKey) {
        throw new Error('paired_environment_without_host_key')
      }
      return {
        environmentId: outcome.environment.id,
        hostKey: orcaHostKeyOf(publicKey),
        label: outcome.environment.name,
        // Only a row this store created carries the name this host chose; an upsert kept the one it already had.
        namedHere: !outcome.updatedExisting
      }
    },
    // Why fired and not awaited: the dep is called from a synchronous position, and an environment with
    // independent SSH access legitimately refuses removal — the member is still cut on the inbound side.
    forgetEnvironment: (selector) => {
      void removeEnvironment(userDataPath, selector).catch((error: unknown) => {
        console.debug('[host-mesh] could not forget the environment', selector, error)
      })
    },
    // Why the catalog broadcast is conditional: every window refetches the pairing list on it, and a pass that
    // rebroadcast a name the store had already suffixed would do that every minute for the rest of the install.
    renameEnvironment: async (environmentId, name) => {
      const { changed } = await renameEnvironment(userDataPath, environmentId, {
        name,
        disambiguate: true
      })
      if (changed) {
        publishRuntimeEnvironmentCatalogChanged()
      }
      return changed
    },
    // Why the peer index and not the pairing rows: another build may rewrite the device registry and drop
    // the fields that would have named this member's row.
    revokeMintedRow: (deviceId) => {
      if (!server.revokeRuntimeAccess(deviceId)) {
        server.getDeviceRegistry()?.removeDevice(deviceId)
      }
    },
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
    // What a peer stores as the name of the pairing it makes with this host when nobody has typed one.
    selfLabel: () => selfLabel(),
    listPairedHostKeys: () => {
      try {
        return listEnvironments(userDataPath).flatMap((environment) => {
          if (environment.endpoints.length === 0) {
            return []
          }
          const publicKey = getPreferredPairedRuntimeConnection(environment).hostPublicKeyB64
          // The public key travels with the host key: a group member with no key cannot be sealed a box,
          // and the repair would skip it forever without saying so.
          return publicKey === undefined
            ? []
            : [
                {
                  hostKey: orcaHostKeyOf(publicKey),
                  label: environment.name,
                  publicKeyB64: publicKey
                }
              ]
        })
      } catch {
        // An unreadable table migrates nothing: a group invented from a failed read would be worse than
        // starting with none, and the next launch retries.
        return []
      }
    },
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
    saveSettings: (settings) => store.writeSettings(settings),
    // Why deferred: the peer that just paired this host is waiting for the reply, and its call has a timeout. The
    // pass is the ordinary scheduled one, so a failure lands in the link states the panel already renders.
    requestOwnSync: () => nudgeHostMeshSync()
  }
}

/**
 * Why a reported label is checked at all: a peer on the build before this one sent the literal `this host` for
 * itself, and storing that as a pairing's name is the placeholder problem again under a different spelling.
 */
function usablePeerLabel(label: string | undefined, hostKey: string): string {
  const wanted = label?.trim() ?? ''
  return wanted === '' || wanted === 'this host'
    ? hostMeshPlaceholderName(hostKey)
    : wanted.slice(0, HOST_MESH_MAX_LABEL_CHARS)
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
