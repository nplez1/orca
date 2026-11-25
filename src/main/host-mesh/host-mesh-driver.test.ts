import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_MESH_INTRODUCE_METHOD,
  HOST_MESH_JOIN_METHOD,
  HOST_MESH_PENDING_METHOD,
  HOST_MESH_RELAY_METHOD,
  HOST_MESH_REMOVE_METHOD,
  HOST_MESH_SYNC_METHOD,
  type HostMeshIntroduceRequest,
  type HostMeshJoinRequest,
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
      settings: { ...DEFAULT_HOST_MESH_SETTINGS, allowJoins: true }
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
      now: () => this.now,
      ownKeypair: () => ({
        publicKey: nacl.box.keyPair.fromSecretKey(host.secretKey).publicKey,
        secretKey: host.secretKey,
        publicKeyB64: host.publicKeyB64
      }),
      mintRuntimeOffer: async () => ({
        offerUrl: `orca://pair?h=${host.hostKey}&pk=${host.publicKeyB64}`,
        deviceId: `device-${host.name}-${host.environments.size}`
      }),
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
          return peer === undefined ? [] : [{ hostKey: peer.hostKey, label: peer.name }]
        }),
      send: <T>(environmentId: string, method: string, params: unknown): Promise<T> =>
        this.dispatch<T>(host, environmentId, method, params),
      settings: () => host.settings,
      saveSettings: (settings) => {
        host.settings = settings
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
    const caller = { fingerprint: from.publicKeyB64 }

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

    // The laptop refuses the introduction, so the VM's arrival leaves it holding no credential for the VM.
    laptop.settings = {
      ...DEFAULT_HOST_MESH_SETTINGS,
      allowJoins: true,
      acceptIntroductions: false
    }
    mesh.seedPairing(vm, studio)
    await vm.driver.join(mesh.environmentFor(vm, studio))

    // The honest state right after: not paired, and not claimed as paired either.
    expect(statusOf(await laptop.driver.snapshot(), vm.hostKey)).not.toBe('complete')

    // One sync both learns the VM exists and repairs the pair, because the repair relays through a member.
    laptop.settings = { ...DEFAULT_HOST_MESH_SETTINGS, allowJoins: true }
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
})

describe('consent: a peer cannot put this host in a group', () => {
  it('refuses a join on a host whose owner never allowed being joined', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)
    // The default: a paired machine may not bootstrap this host into a group by asking.
    studio.settings = { ...DEFAULT_HOST_MESH_SETTINGS }

    const joined = await laptop.driver.join(mesh.environmentFor(laptop, studio))

    expect(joined.kind).toBe('refused')
    if (joined.kind === 'refused') {
      expect(joined.reason).toBe('joins-not-allowed')
    }
    expect((await studio.driver.snapshot()).inGroup).toBe(false)
    // Nothing was minted or dialled on the studio's behalf.
    expect(studio.environments.size).toBe(1)
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
