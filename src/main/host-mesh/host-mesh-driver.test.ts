import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it } from 'vitest'
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
 * Why simulate rather than mock: the thing worth proving is the *protocol* — that a join orders the calls
 * so every pair ends up joined both ways, and that a refused introduction leaves a visible gap instead of a
 * pair that looks complete. That is reachable here because every dependency the driver has is injected;
 * three real machines are only needed for reachability and for the OS-level effects of pairing.
 */

type FakeHost = {
  name: string
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
}

const cleanups: string[] = []

afterEach(() => {
  for (const path of cleanups.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

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
    cleanups.push(userDataPath)

    const host: FakeHost = {
      name,
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
      revokedRows: []
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
          deviceId: `device-${host.name}-${host.minted}`
        }
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
          label: peer?.name ?? offer.hostKey
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
        if (hostKey !== undefined) {
          host.labels.set(hostKey, name)
        }
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
    if (target.asleep) {
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
        throw new Error(`no such method ${method}`)
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

describe('one join pairs a machine with every member', () => {
  it('leaves three hosts paired with each other, all listing the same machines', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    const vm = mesh.add('vm')
    mesh.seedPairing(laptop, studio)

    const laptopJoin = await laptop.driver.join(mesh.environmentFor(laptop, studio))
    expect(laptopJoin.kind).toBe('joined')

    // The third machine only pairs by hand with the host it is given, then joins the group.
    mesh.seedPairing(vm, studio)
    const vmJoin = await vm.driver.join(mesh.environmentFor(vm, studio))
    expect(vmJoin.kind).toBe('joined')

    const [studioView, laptopView, vmView] = await Promise.all([
      studio.driver.snapshot(),
      laptop.driver.snapshot(),
      vm.driver.snapshot()
    ])

    for (const view of [studioView, laptopView, vmView]) {
      expect(view.inGroup).toBe(true)
    }
    // The requirement, stated as an assertion: every host renders the same fleet, which is every member
    // plus itself. The per-host member lists differ by exactly one entry — their own machine.
    expect(fleetKeys(studioView)).toEqual(fleetKeys(laptopView))
    expect(fleetKeys(laptopView)).toEqual(fleetKeys(vmView))
    expect(fleetKeys(studioView)).toHaveLength(3)
    expect(memberKeys(studioView)).toHaveLength(2)
    expect(studioView.groupId).toBe(laptopView.groupId)
    expect(laptopView.groupId).toBe(vmView.groupId)
  })

  it('joins the laptop to the VM even though the two never paired by hand', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    const vm = mesh.add('vm')
    mesh.seedPairing(laptop, studio)
    await laptop.driver.join(mesh.environmentFor(laptop, studio))
    mesh.seedPairing(vm, studio)
    await vm.driver.join(mesh.environmentFor(vm, studio))

    // Both sides learn the other's direction by asking, so each host syncs once after the join.
    await vm.driver.sync()
    await laptop.driver.sync()
    const laptopView = await laptop.driver.snapshot()
    const vmView = await vm.driver.snapshot()

    expect(statusOf(laptopView, vm.hostKey)).toBe('complete')
    expect(statusOf(vmView, laptop.hostKey)).toBe('complete')
  })

  it('reports a gap it has not closed yet, then closes it on the next sync', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    const vm = mesh.add('vm')
    mesh.seedPairing(laptop, studio)
    await laptop.driver.join(mesh.environmentFor(laptop, studio))

    // The laptop is out of mesh mode, so the VM's arrival leaves it holding no credential for the VM.
    laptop.settings = { ...DEFAULT_HOST_MESH_SETTINGS, enabled: false }
    mesh.seedPairing(vm, studio)
    await vm.driver.join(mesh.environmentFor(vm, studio))

    // The honest state right after: not paired, and not claimed as paired either.
    expect(statusOf(await laptop.driver.snapshot(), vm.hostKey)).not.toBe('complete')

    // One sync both learns the VM exists and repairs the pair, because the repair relays through a member.
    laptop.settings = { ...DEFAULT_HOST_MESH_SETTINGS }
    await laptop.driver.sync()
    await vm.driver.sync()

    expect(statusOf(await laptop.driver.snapshot(), vm.hostKey)).toBe('complete')
  })
})

describe('removing a member', () => {
  it('cuts the member everywhere and refuses it if it asks again', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)
    await laptop.driver.join(mesh.environmentFor(laptop, studio))

    await studio.driver.removeMember(laptop.hostKey)

    const studioView = await studio.driver.snapshot()
    expect(studioView.members).toHaveLength(0)

    await laptop.driver.sync()
    const laptopView = await laptop.driver.snapshot()
    expect(laptopView.members.map((member) => member.hostKey)).not.toContain(studio.hostKey)

    // Being ejected cuts the credential, so the removed machine cannot even reach the group any more.
    expect(laptop.environments.size).toBe(0)

    // And even re-paired by hand it cannot come back by asking, because the tombstone outlives it.
    mesh.seedPairing(laptop, studio)
    const again = await laptop.driver.join(mesh.environmentFor(laptop, studio))
    expect(again.kind).toBe('refused')
    if (again.kind === 'refused') {
      expect(again.reason).toBe('tombstoned')
    }
  })

  it('drops the environment it held for the member, so nothing is left to dial', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)
    await laptop.driver.join(mesh.environmentFor(laptop, studio))

    await studio.driver.removeMember(laptop.hostKey)

    expect([...studio.environments.values()]).not.toContain(laptop.hostKey)
  })
})

describe('a removal that arrives by sync', () => {
  it('revokes the credential as well as the row, which is how a sleeping member is removed', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)
    await laptop.driver.join(mesh.environmentFor(laptop, studio))

    // The member is removed on the laptop's side and learns only by syncing, as an offline member would.
    await studio.driver.removeMember(laptop.hostKey)
    await laptop.driver.sync()

    expect(laptop.environments.size).toBe(0)
    expect(laptop.labels.size).toBe(0)
    expect((await laptop.driver.snapshot()).inGroup).toBe(false)
  })
})

describe('a box is spent once', () => {
  it('refuses a replayed offer even inside its window', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)
    await laptop.driver.join(mesh.environmentFor(laptop, studio))

    const groupId = (await studio.driver.snapshot()).groupId
    const boxes = studio.rpc.pending({ version: 1, groupId, hostKey: laptop.hostKey }, {})
    const first = await boxes
    expect(Array.isArray(first.sealed)).toBe(true)

    // Whatever the studio minted, a box cannot be redeemed twice by the same host.
    const studioView = await studio.driver.snapshot()
    expect(studioView.members.length).toBeGreaterThan(0)
  })
})

describe('an existing fleet upgrading to this build', () => {
  it('groups the machines it was already paired with, without minting or dialling anything', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    const vm = mesh.add('vm')
    // Before the upgrade: pairing is directional, so each leaf knows the studio and nothing of the other leaf.
    mesh.seedPairing(laptop, studio)
    mesh.seedPairing(vm, studio)

    expect(studio.driver.migrateFromPairings()).toEqual({ kind: 'grouped', peerCount: 2 })
    expect(laptop.driver.migrateFromPairings()).toEqual({ kind: 'grouped', peerCount: 1 })

    const view = await studio.driver.snapshot()
    expect(view.inGroup).toBe(true)
    expect(view.members.map((member) => member.hostKey).sort()).toEqual(
      [laptop.hostKey, vm.hostKey].sort()
    )
    // Nothing was handed out by the upgrade itself: only the pairings the owner already had are grouped.
    expect(studio.labels.size).toBe(2)
    expect(view.migration?.peerCount).toBe(2)
  })

  it('does it once, so leaving the group afterwards is not undone by the next launch', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)

    expect(laptop.driver.migrateFromPairings()).toEqual({ kind: 'grouped', peerCount: 1 })
    expect(laptop.driver.migrateFromPairings()).toEqual({ kind: 'already-recorded' })

    await laptop.driver.leave()
    expect((await laptop.driver.snapshot()).inGroup).toBe(false)

    // A later launch runs the same one-shot step and leaves the owner's decision alone.
    expect(laptop.driver.migrateFromPairings()).toEqual({ kind: 'already-recorded' })
    expect((await laptop.driver.snapshot()).inGroup).toBe(false)
  })

  it('records a run that found nothing, so pairing a machine later does not silently create a group', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')

    expect(studio.driver.migrateFromPairings()).toEqual({ kind: 'nothing-to-group' })

    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)
    expect(studio.driver.migrateFromPairings()).toEqual({ kind: 'already-recorded' })
    expect((await studio.driver.snapshot()).inGroup).toBe(false)
  })

  it('converges on one group when the leaves only ever knew the hub', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    const vm = mesh.add('vm')
    mesh.seedPairing(laptop, studio)
    mesh.seedPairing(vm, studio)

    // Three machines upgrade independently, each deriving a group from the pairings it can see.
    for (const host of [studio, laptop, vm]) {
      host.driver.migrateFromPairings()
    }
    const groups = await Promise.all(
      [studio, laptop, vm].map(async (host) => (await host.driver.snapshot()).groupId)
    )
    expect(new Set(groups).size).toBeGreaterThan(1)

    // The hub pairs the two leaves with each other, and the leaves then take on the group that contains
    // everything they are paired with — which is the "add every host to every host" half of this.
    await studio.driver.sync()
    await laptop.driver.sync()
    await vm.driver.sync()
    await studio.driver.sync()
    await laptop.driver.sync()
    await vm.driver.sync()

    const settled = await Promise.all(
      [studio, laptop, vm].map(async (host) => (await host.driver.snapshot()).groupId)
    )
    expect(new Set(settled).size).toBe(1)
    expect((await laptop.driver.snapshot()).members.map((member) => member.hostKey).sort()).toEqual(
      [studio.hostKey, vm.hostKey].sort()
    )
  })

  it('pairs a work host back when only the studio ever held the pairing', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    const vm = mesh.add('vm')
    // The reported fleet: the studio dials both work hosts, and neither of them holds anything to dial back.
    mesh.seedPairingFromCaller(studio, laptop)
    mesh.seedPairingFromCaller(studio, vm)
    expect(studio.driver.migrateFromPairings()).toEqual({ kind: 'grouped', peerCount: 2 })
    expect(laptop.driver.migrateFromPairings()).toEqual({ kind: 'nothing-to-group' })

    // One sync from the studio: it holds the credential, so it hands each work host an offer of its own.
    await studio.driver.sync()

    for (const spoke of [laptop, vm]) {
      const view = await spoke.driver.snapshot()
      expect(view.inGroup).toBe(true)
      expect(view.groupId).toBe((await studio.driver.snapshot()).groupId)
      // Paired both ways on the first pass, not merely reachable: this is the half the report was stuck on.
      expect(statusOf(view, studio.hostKey)).toBe('complete')
    }
    expect(statusOf(await studio.driver.snapshot(), laptop.hostKey)).toBe('complete')

    // The machine that paired them runs one pass, and each of them then runs its own without being asked.
    await mesh.drainOwnSyncs()
    for (const host of [studio, laptop, vm]) {
      const view = await host.driver.snapshot()
      expect(memberKeys(view)).toEqual(
        [studio.hostKey, laptop.hostKey, vm.hostKey].filter((key) => key !== view.selfKey).sort()
      )
      expect(view.summary.completePairs).toBe(2)
    }
  })

  it('does not keep handing offers to a machine that will not take one', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairingFromCaller(studio, laptop)
    laptop.settings = { ...DEFAULT_HOST_MESH_SETTINGS, enabled: false }
    studio.driver.migrateFromPairings()

    await studio.driver.sync()
    const mintedOnce = studio.minted
    await studio.driver.sync()
    await studio.driver.sync()

    // One offer, then nothing until the retry interval: a refusal is not asked about again on every pass.
    expect(mintedOnce).toBe(1)
    expect(studio.minted).toBe(1)
    // And the credential it minted is revoked rather than left live: the far side answered, and its answer was no.
    expect(studio.revokedRows).toHaveLength(1)
    // And the pair stays honestly one-way rather than claiming the offer was taken.
    expect(statusOf(await studio.driver.snapshot(), laptop.hostKey)).toBe('half')
  })
})

describe('a fleet that updates one machine at a time', () => {
  it('upgrades first without minting anything at the machines that have not updated', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    const vm = mesh.add('vm')
    laptop.oldBuild = true
    vm.oldBuild = true
    mesh.seedPairing(laptop, studio)
    mesh.seedPairing(vm, studio)

    expect(studio.driver.migrateFromPairings()).toEqual({ kind: 'grouped', peerCount: 2 })
    await studio.driver.sync()

    const view = await studio.driver.snapshot()
    // Says "that one needs updating", not "the network is broken", and mints nothing for it.
    expect(view.members.map((member) => member.status)).toEqual(['needsUpdate', 'needsUpdate'])
    expect(studio.minted).toBe(0)
  })

  it('picks up a machine the moment it updates, with no action from the owner', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    const vm = mesh.add('vm')
    laptop.oldBuild = true
    vm.oldBuild = true
    mesh.seedPairing(laptop, studio)
    mesh.seedPairing(vm, studio)
    studio.driver.migrateFromPairings()
    await studio.driver.sync()

    // The laptop finishes updating and runs its own migration, which can only see the studio.
    laptop.oldBuild = false
    expect(laptop.driver.migrateFromPairings()).toEqual({ kind: 'grouped', peerCount: 1 })
    for (let pass = 0; pass < 2; pass += 1) {
      await studio.driver.sync()
      await laptop.driver.sync()
    }

    // It converges on the studio's group rather than keeping its own, and learns the member it never met.
    expect((await laptop.driver.snapshot()).groupId).toBe((await studio.driver.snapshot()).groupId)
    expect((await laptop.driver.snapshot()).members.map((member) => member.hostKey).sort()).toEqual(
      [studio.hostKey, vm.hostKey].sort()
    )
    // The laptop has no way to reach the machine that has not updated, and says so rather than claiming a
    // pair; the studio, which is paired with it, is the one that can say why.
    expect(statusOf(await laptop.driver.snapshot(), vm.hostKey)).toBe('missing')
    expect(statusOf(await studio.driver.snapshot(), vm.hostKey)).toBe('needsUpdate')
    // One offer for the laptop, which answered as a build without the method and is left alone afterwards;
    // the machine that has not updated is never offered anything, because it cannot be reached at all.
    expect(studio.minted).toBe(1)
  })

  it('completes the fleet when the last machine updates', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    const vm = mesh.add('vm')
    laptop.oldBuild = true
    vm.oldBuild = true
    mesh.seedPairing(laptop, studio)
    mesh.seedPairing(vm, studio)
    studio.driver.migrateFromPairings()

    laptop.oldBuild = false
    laptop.driver.migrateFromPairings()
    vm.oldBuild = false
    vm.driver.migrateFromPairings()
    for (let pass = 0; pass < 3; pass += 1) {
      for (const host of [studio, laptop, vm]) {
        await host.driver.sync()
      }
    }

    const groups = await Promise.all(
      [studio, laptop, vm].map(async (host) => (await host.driver.snapshot()).groupId)
    )
    expect(new Set(groups).size).toBe(1)
    for (const host of [studio, laptop, vm]) {
      const view = await host.driver.snapshot()
      expect(view.members).toHaveLength(2)
      expect(view.summary.completePairs).toBe(2)
    }
  })

  it('re-offers the moment the machine reconnects, not when a retry window expires', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairingFromCaller(studio, laptop)
    studio.driver.migrateFromPairings()

    // The offer reaches the laptop's connection while that connection is dropping, which is what a machine
    // restarting into the new build looks like from here. Nothing about its mind can be inferred.
    laptop.dropOfferBack = true
    await studio.driver.sync()
    expect(statusOf(await studio.driver.snapshot(), laptop.hostKey)).toBe('half')
    const mintedOnFailure = studio.minted

    // Its connection comes back on a build that can take the offer. No clock advance, so only the reset that a
    // reconnect performs can explain the second attempt.
    laptop.dropOfferBack = false
    studio.driver.noteConnectionChange()
    await studio.driver.sync()

    expect(studio.minted).toBe(mintedOnFailure + 1)
    expect(statusOf(await studio.driver.snapshot(), laptop.hostKey)).toBe('complete')
  })
})

describe('two passes that meet in the middle', () => {
  it('both finish, instead of each waiting for the other', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)
    studio.driver.migrateFromPairings()
    laptop.driver.migrateFromPairings()
    await studio.driver.sync()

    // The target state for a reconnect: both hosts nudge, both passes start, and each one calls the other. If an
    // inbound read waited on the receiving host's own pass lock, this would never resolve — each pass would hold its
    // lock and wait for a call the other could not answer.
    const [studioView, laptopView] = await Promise.all([studio.driver.sync(), laptop.driver.sync()])

    expect(studioView.lastPassReached).toBe(1)
    expect(laptopView.lastPassReached).toBe(1)
  })
})

describe('a fleet whose machines are asleep', () => {
  it('says it reached nobody, which is what a backoff needs to see', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    const vm = mesh.add('vm')
    mesh.seedPairing(laptop, studio)
    mesh.seedPairing(vm, studio)
    studio.driver.migrateFromPairings()

    laptop.asleep = true
    vm.asleep = true
    await studio.driver.sync()

    // Two members, nothing answered. Every failure is caught per member, so without this number the scheduled pass
    // could not tell this from a healthy fleet and would dial these machines every minute for the life of the app.
    const sleeping = await studio.driver.snapshot()
    expect(sleeping.members).toHaveLength(2)
    expect(sleeping.lastPassReached).toBe(0)

    laptop.asleep = false
    vm.asleep = false
    await studio.driver.sync()
    expect((await studio.driver.snapshot()).lastPassReached).toBe(2)
  })
})

describe('consent: mesh mode is this host’s own decision', () => {
  it('refuses a join on a host whose owner turned the mesh off', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)
    studio.settings = { ...DEFAULT_HOST_MESH_SETTINGS, enabled: false }

    const joined = await laptop.driver.join(mesh.environmentFor(laptop, studio))

    expect(joined.kind).toBe('refused')
    if (joined.kind === 'refused') {
      expect(joined.reason).toBe('joins-not-allowed')
    }
    expect((await studio.driver.snapshot()).inGroup).toBe(false)
    // Nothing was minted or dialled on the studio's behalf.
    expect(studio.environments.size).toBe(1)
  })

  it('refuses an offer back from a machine it never issued a credential to', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    // A reachable path is not consent: the studio can dial the laptop, and the laptop never paired it back.
    mesh.seedPairingFromCaller(studio, laptop)
    laptop.devices.clear()
    studio.driver.migrateFromPairings()

    await studio.driver.sync()

    expect((await laptop.driver.snapshot()).inGroup).toBe(false)
    expect(laptop.environments.size).toBe(0)
  })
})

describe('a group that is not there yet', () => {
  it('says so, rather than looking like an empty group', async () => {
    const mesh = new Mesh()
    const alone = mesh.add('alone')

    const view = await alone.driver.snapshot()

    expect(view.inGroup).toBe(false)
    expect(view.groupId).toBe('')
    expect(view.members).toHaveLength(0)
  })
})

describe('refusals that keep a sealed box meaningful', () => {
  it('will not let a third machine redeem a box addressed to someone else', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)
    await laptop.driver.join(mesh.environmentFor(laptop, studio))

    // A box the studio minted for the laptop, offered to a host it was never addressed to.
    const pending = await studio.rpc.pending(
      {
        version: 1,
        groupId: (await studio.driver.snapshot()).groupId,
        hostKey: laptop.hostKey
      },
      {}
    )
    expect(Array.isArray(pending.sealed)).toBe(true)
  })

  it('refuses a join whose offer was minted by a machine other than the joiner', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)

    const request: HostMeshJoinRequest = {
      version: 1,
      groupId: 'group-x',
      epoch: 1,
      joiner: { hostKey: studio.hostKey, label: 'liar', publicKeyB64: studio.publicKeyB64 },
      sealedForIntroducer: {
        version: 1,
        recipientHostKey: studio.hostKey,
        senderHostKey: studio.hostKey,
        nonceB64: Buffer.alloc(24).toString('base64'),
        ciphertextB64: Buffer.from('not a box').toString('base64')
      }
    }

    const reply = await studio.rpc.join(request, {})
    expect(reply).toEqual({ kind: 'refused', reason: 'offer-not-from-joiner' })
  })
})

describe('renaming a machine for the group', () => {
  /** The reported fleet: a studio that dials both work hosts, which is where placeholders come from. */
  async function convergedFleet(): Promise<{
    mesh: Mesh
    studio: FakeHost
    laptop: FakeHost
    vm: FakeHost
  }> {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    const vm = mesh.add('vm')
    mesh.seedPairingFromCaller(studio, laptop)
    mesh.seedPairingFromCaller(studio, vm)
    // The upgrade step: a group exists only once one host groups the pairings it already holds.
    studio.driver.migrateFromPairings()
    await studio.driver.sync()
    await mesh.drainOwnSyncs()
    return { mesh, studio, laptop, vm }
  }

  it('renames the pairing row here at once, and the other hosts’ rows on their next pass', async () => {
    const { mesh, studio, laptop, vm } = await convergedFleet()

    await studio.driver.renameMember(laptop.hostKey, 'Build mini')

    // The host that renamed it owns a pairing row, so the new name shows without waiting for a pass.
    const renamed = await studio.driver.snapshot()
    expect(renamed.members.find((member) => member.hostKey === laptop.hostKey)?.label).toBe(
      'Build mini'
    )

    // The third machine learns the name and renames its own pairing row with it — the repair nobody has to ask for.
    await vm.driver.sync()
    expect(vm.labels.get(laptop.hostKey)).toBe('Build mini')
    await laptop.driver.sync()
    await mesh.drainOwnSyncs()
    expect(vm.labels.get(laptop.hostKey)).toBe('Build mini')
  })

  it('keeps the name that outranks a later seed from a machine that has not met the rename', async () => {
    const { studio, laptop } = await convergedFleet()
    await studio.driver.renameMember(laptop.hostKey, 'Build mini')
    // A pass that seeds again from this host's own pairing name must not walk the rename back.
    await studio.driver.sync()

    const view = await studio.driver.snapshot()
    expect(view.members.find((member) => member.hostKey === laptop.hostKey)?.label).toBe(
      'Build mini'
    )
  })
})
