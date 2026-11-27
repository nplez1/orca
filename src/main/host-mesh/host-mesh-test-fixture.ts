import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import {
  HOST_MESH_INTRODUCE_METHOD,
  HOST_MESH_JOIN_METHOD,
  HOST_MESH_OFFER_BACK_METHOD,
  HOST_MESH_PENDING_METHOD,
  HOST_MESH_RELAY_METHOD,
  HOST_MESH_REMOVE_METHOD,
  HOST_MESH_SYNC_METHOD,
  type HostMeshIntroduceRequest,
  type HostMeshJoinRequest,
  type HostMeshOfferBackRequest,
  type HostMeshPendingRequest,
  type HostMeshRelayRequest,
  type HostMeshRemoveRequest
} from '../../shared/host-mesh/host-mesh-contract'
import {
  DEFAULT_HOST_MESH_SETTINGS,
  type HostMeshSettings
} from '../../shared/host-mesh/host-mesh-admission'
import { orcaHostKeyOf } from '../host-graph/host-graph-self-identity'
import { createHostMeshDriver, createHostMeshRpcService } from './host-mesh-driver'
import { createHostMeshWriteLock } from './host-mesh-write-lock'
import type {
  HostMeshDriver,
  HostMeshDriverDeps,
  HostMeshRpcService,
  HostMeshSnapshot
} from './host-mesh-driver-contract'

/**
 * A whole mesh on one machine: several hosts, each with its own store, keys and environment table, talking
 * through a transport that routes by environment id.
 *
 * Why simulate rather than mock: the thing worth proving is the *protocol* — that a join orders the calls so
 * every pair ends up joined both ways, and that a refused introduction leaves a visible gap instead of a pair
 * that looks complete. That is reachable here because every dependency the driver has is injected; three real
 * machines are only needed for reachability and for the OS-level effects of pairing.
 */

type FakeHost = {
  name: string
  userDataPath: string
  publicKeyB64: string
  secretKey: Uint8Array
  hostKey: string
  driver: HostMeshDriver
  rpc: HostMeshRpcService
  /** environmentId -> the host it reaches. */
  environments: Map<string, string>
  labels: Map<string, string>
  settings: HostMeshSettings
  /** A machine still on a build without the mesh: it answers, but not these methods. */
  oldBuild: boolean
  /** A connection that drops mid-call, which is what makes an offer back fail for a reason no refusal explains. */
  dropOfferBack: boolean
  /** A machine whose lid is closed: it is a member with an environment, and nothing answers on it. */
  asleep: boolean
  /** Machines this host issued a device credential to: who may reach it, which is one half of a pairing. */
  devices: Set<string>
  /** Offers this host has minted, which is what an unreachable peer would make it waste. */
  minted: number
  /** Device rows this host revoked again because the offer they belonged to was never taken. */
  revokedRows: string[]
  /** Addresses this host publishes as its own, which a member keeps as routes. */
  endpoints: string[]
  /** The address each pairing row currently dials, standing in for the endpoint in the pairing store. */
  dialed: Map<string, string>
  /** Addresses this host can be reached at right now; anything else is the wrong network. */
  reachableAt: string[]
  /** What this host adopted after a pairing row's own path failed. */
  adopted: { environmentId: string; candidates: string[]; endpoint: string }[]
}

/** Every temp directory a simulated host was given, so a test file can remove them after itself. */
export const meshTempDirs: string[] = []

class Mesh {
  readonly hosts = new Map<string, FakeHost>()
  now = 1_700_000_000_000
  /** Hosts that asked for a pass of their own, which the real deps defer to a tick. */
  readonly ownSyncs: FakeHost[] = []

  add(name: string): FakeHost {
    const keypair = nacl.box.keyPair()
    const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64')
    const hostKey = orcaHostKeyOf(publicKeyB64)
    const userDataPath = mkdtempSync(join(tmpdir(), `orca-mesh-${name}-`))
    meshTempDirs.push(userDataPath)

    const host: FakeHost = {
      name,
      userDataPath,
      publicKeyB64,
      secretKey: keypair.secretKey,
      hostKey,
      // SAFETY: both are assigned two lines below, before any test can reach the host.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placeholder filled before use
      driver: null as unknown as HostMeshDriver,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placeholder filled before use
      rpc: null as unknown as HostMeshRpcService,
      environments: new Map(),
      labels: new Map(),
      settings: { ...DEFAULT_HOST_MESH_SETTINGS },
      oldBuild: false,
      dropOfferBack: false,
      asleep: false,
      devices: new Set(),
      minted: 0,
      revokedRows: [],
      endpoints: [],
      dialed: new Map(),
      // Why reachable by default: only a test that simulates a machine which moved makes an address matter.
      reachableAt: ['default'],
      adopted: []
    }
    const deps = this.depsFor(host, userDataPath)
    host.driver = createHostMeshDriver(deps)
    host.rpc = createHostMeshRpcService(deps)
    this.hosts.set(hostKey, host)
    return host
  }

  /** The pairing a person performs by hand before any of this: both hosts end up holding each other. */
  seedPairing(left: FakeHost, right: FakeHost): void {
    this.pairOneWay(left, right)
    this.pairOneWay(right, left)
  }

  /**
   * The pairing this fork's own fleet has: the caller holds the environment, the callee holds a device row.
   *
   * Why this is the case worth simulating: it is what a studio dialling two work hosts leaves behind, and it is
   * the shape every real upgrade has — a spoke can call nobody, so nothing but an offer handed to it can pair it.
   */
  seedPairingFromCaller(caller: FakeHost, callee: FakeHost): void {
    this.pairOneWay(caller, callee)
    callee.devices.add(caller.hostKey)
  }

  private pairOneWay(holder: FakeHost, peer: FakeHost): void {
    holder.environments.set(`${holder.name}->${peer.name}`, peer.hostKey)
    holder.labels.set(peer.hostKey, peer.name)
  }

  environmentFor(holder: FakeHost, peer: FakeHost): string {
    for (const [environmentId, hostKey] of holder.environments) {
      if (hostKey === peer.hostKey) {
        return environmentId
      }
    }
    throw new Error(`${holder.name} holds no environment for ${peer.name}`)
  }

  private depsFor(host: FakeHost, userDataPath: string): HostMeshDriverDeps {
    return {
      userDataPath,
      // The real app shares ONE lock per host between the driver and the peer-facing service, so a test that did not
      // would miss the cycle two hosts can form: A's pass holds A's lock while calling B, whose handler waits on B's
      // pass, which is waiting on A.
      lock: createHostMeshWriteLock(),
      now: () => this.now,
      ownKeypair: () => ({
        publicKey: nacl.box.keyPair.fromSecretKey(host.secretKey).publicKey,
        secretKey: host.secretKey,
        publicKeyB64: host.publicKeyB64
      }),
      mintRuntimeOffer: async () => {
        host.minted += 1
        return {
          offerUrl: `orca://pair?h=${host.hostKey}&pk=${host.publicKeyB64}`,
          deviceId: `device-${host.name}-${host.minted}`,
          endpointCandidates: host.endpoints
        }
      },
      ownEndpoints: async () => host.endpoints,
      // What the real deps do: try each address the peer published, and adopt the first that answers by pointing the
      // pairing row at it. A fake cannot probe, so an address answers when the peer lists it as reachable.
      adoptReachableEndpoint: async ({ environmentId, candidates }) => {
        const targetKey = host.environments.get(environmentId)
        const target = targetKey === undefined ? undefined : this.hosts.get(targetKey)
        const usable = candidates.find(
          (endpoint) => target?.reachableAt.includes(endpoint) ?? false
        )
        if (target === undefined || usable === undefined) {
          return null
        }
        host.dialed.set(environmentId, usable)
        host.adopted.push({ environmentId, candidates: [...candidates], endpoint: usable })
        return usable
      },
      redeemOffer: async (offerUrl, expectedHostKey) => {
        const offer = parseFakeOffer(offerUrl)
        if (offer.hostKey !== expectedHostKey) {
          throw new Error('offer-not-from-expected-minter')
        }
        const peer = this.hosts.get(offer.hostKey)
        // Upsert, like the real add-or-update path: a peer this host already holds keeps ONE environment.
        const existing = [...host.environments].find(([, target]) => target === offer.hostKey)?.[0]
        const environmentId = existing ?? `${host.name}->${offer.hostKey}`
        host.environments.set(environmentId, offer.hostKey)
        host.labels.set(offer.hostKey, peer?.name ?? offer.hostKey)
        return {
          environmentId,
          hostKey: offer.hostKey,
          label: peer?.name ?? offer.hostKey,
          namedHere: existing === undefined
        }
      },
      revokeMintedRow: (deviceId: string) => {
        host.revokedRows.push(deviceId)
      },
      forgetEnvironment: (selector) => {
        for (const [environmentId, hostKey] of host.environments) {
          if (environmentId === selector || hostKey === selector) {
            host.environments.delete(environmentId)
          }
        }
      },
      forgetDevice: (hostKey) => {
        host.labels.delete(hostKey)
      },
      environmentIdForHostKey: (hostKey) => {
        for (const [environmentId, target] of host.environments) {
          if (target === hostKey) {
            return environmentId
          }
        }
        return null
      },
      labelForHostKey: (hostKey) => host.labels.get(hostKey) ?? null,
      // What an upgrade reads: the pairings this host already holds. Only the migration test calls it.
      listPairedHostKeys: () =>
        [...host.environments.values()].flatMap((target) => {
          const peer = [...this.hosts.values()].find((entry) => entry.hostKey === target)
          return peer === undefined
            ? []
            : [{ hostKey: peer.hostKey, label: peer.name, publicKeyB64: peer.publicKeyB64 }]
        }),
      send: <T>(environmentId: string, method: string, params: unknown): Promise<T> =>
        this.dispatch<T>(host, environmentId, method, params),
      settings: () => host.settings,
      saveSettings: (settings) => {
        host.settings = settings
      },
      // The pairing store's name for a peer, which is what every surface reads.
      renameEnvironment: async (environmentId, name) => {
        const hostKey = host.environments.get(environmentId)
        if (hostKey === undefined) {
          return false
        }
        const changed = host.labels.get(hostKey) !== name
        host.labels.set(hostKey, name)
        return changed
      },
      requestOwnSync: () => {
        this.ownSyncs.push(host)
      }
    }
  }

  /** Runs every pass a host asked for after being paired, until nothing asks again. */
  async drainOwnSyncs(rounds = 4): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      const pending = this.ownSyncs.splice(0)
      if (pending.length === 0) {
        return
      }
      for (const host of pending) {
        await host.driver.sync()
      }
    }
  }

  private async dispatch<T>(
    from: FakeHost,
    environmentId: string,
    method: string,
    params: unknown
  ): Promise<T> {
    const targetKey = from.environments.get(environmentId)
    const target = targetKey === undefined ? undefined : this.hosts.get(targetKey)
    if (target === undefined) {
      throw new Error(`${from.name} cannot reach ${environmentId}`)
    }
    // Why the dialed address is checked as well as the lid: a pairing reaches a member only at the address its row
    // names, so a machine that moved networks is unreachable until a pass adopts another one.
    if (
      target.asleep ||
      !target.reachableAt.includes(from.dialed.get(environmentId) ?? 'default')
    ) {
      throw new Error('connection-closed')
    }
    // The real transport answers an unknown method with this code, and the driver reads it as such.
    if (target.oldBuild) {
      throw new Error('method_not_found')
    }
    const caller = {
      fingerprint: from.publicKeyB64,
      // Why from the callee's own registry: a token this host issued is the whole trust anchor for an offer back.
      ...(target.devices.has(from.hostKey) ? { pairedDeviceId: `device-${from.name}` } : {})
    }

    switch (method) {
      case HOST_MESH_SYNC_METHOD:
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller built this payload from HostMeshPendingRequest
        return target.rpc.sync(params as HostMeshPendingRequest, caller) as Promise<T>
      case HOST_MESH_JOIN_METHOD:
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller built this payload from HostMeshJoinRequest
        return target.rpc.join(params as HostMeshJoinRequest, caller) as Promise<T>
      case HOST_MESH_RELAY_METHOD:
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller built this payload from HostMeshRelayRequest
        return target.rpc.relayIntroductions(params as HostMeshRelayRequest, caller) as Promise<T>
      case HOST_MESH_INTRODUCE_METHOD:
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller built this payload from HostMeshIntroduceRequest
        return target.rpc.introduce(params as HostMeshIntroduceRequest, caller) as Promise<T>
      case HOST_MESH_PENDING_METHOD:
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller built this payload from HostMeshPendingRequest
        return target.rpc.pending(params as HostMeshPendingRequest, caller) as Promise<T>
      case HOST_MESH_OFFER_BACK_METHOD:
        if (target.dropOfferBack) {
          // The transport failing, not the machine refusing: no reply, so nothing about its mind is known.
          throw new Error('connection-closed')
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller built this payload from HostMeshOfferBackRequest
        return target.rpc.offerBack(params as HostMeshOfferBackRequest, caller) as Promise<T>
      case HOST_MESH_REMOVE_METHOD:
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller built this payload from HostMeshRemoveRequest
        return target.rpc.remove(params as HostMeshRemoveRequest, caller) as Promise<T>
      default:
        throw Object.assign(new Error(`no such method ${method}`), { peerCode: 'method_not_found' })
    }
  }
}

function parseFakeOffer(offerUrl: string): { hostKey: string; publicKeyB64: string } {
  const params = new URLSearchParams(offerUrl.slice(offerUrl.indexOf('?') + 1))
  const hostKey = params.get('h')
  const publicKeyB64 = params.get('pk')
  if (hostKey === null || publicKeyB64 === null) {
    throw new Error('malformed fake offer')
  }
  return { hostKey, publicKeyB64 }
}

/** The fleet a host would render: its own machines plus every member's, which is the real requirement. */
function fleetKeys(snapshot: HostMeshSnapshot): string[] {
  return [...snapshot.members.map((member) => member.hostKey), snapshot.selfKey].sort()
}

/** What a host lists as members, which by construction never includes itself. */
function memberKeys(snapshot: HostMeshSnapshot): string[] {
  return snapshot.members.map((member) => member.hostKey).sort()
}

function statusOf(snapshot: HostMeshSnapshot, hostKey: string): string {
  return snapshot.members.find((member) => member.hostKey === hostKey)?.status ?? 'absent'
}

export { parseFakeOffer, fleetKeys, memberKeys, statusOf, Mesh }
export type { FakeHost }
