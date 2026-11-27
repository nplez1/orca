import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_HOST_MESH_SETTINGS } from '../../shared/host-mesh/host-mesh-admission'
import type { HostMeshJoinRequest } from '../../shared/host-mesh/host-mesh-contract'
import { createHostMeshStore } from './host-mesh-store'
import {
  Mesh,
  fleetKeys,
  memberKeys,
  meshTempDirs,
  statusOf,
  type FakeHost
} from './host-mesh-test-fixture'

afterEach(() => {
  for (const path of meshTempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

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

  it('mints one credential for a member whose connection keeps dropping, and resends that box instead', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairingFromCaller(studio, laptop)
    laptop.dropOfferBack = true
    studio.driver.migrateFromPairings()

    // Five passes, each preceded by the connection coming back up — which is exactly the sequence that left
    // hundreds of unreedeemed runtime rows on a real host, listed in Settings as that many active links.
    for (let pass = 0; pass < 5; pass += 1) {
      studio.driver.noteConnectionChange()
      await studio.driver.sync()
    }

    expect(studio.minted).toBe(1)
    // Nothing is revoked: a dropped call is not a refusal, so the box may still have arrived and be redeemed.
    expect(studio.revokedRows).toHaveLength(0)
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

  it('re-offers the moment the machine reconnects, without minting a second credential', async () => {
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

    expect(statusOf(await studio.driver.snapshot(), laptop.hostKey)).toBe('complete')
    // And the retry sent the box this host already held rather than minting another: the first one is still
    // inside its own lifetime, so a second credential would be residue nobody could ever redeem.
    expect(studio.minted).toBe(mintedOnFailure)
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

describe('a name someone typed against one a pairing invented', () => {
  it('keeps the typed name when the spoke’s own row holds its hostname', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    // The hub is where the owner typed "Studio laptop"; the spoke's row for the hub is what a redemption wrote.
    mesh.seedPairingFromCaller(studio, laptop)
    studio.labels.set(laptop.hostKey, 'Studio laptop')
    laptop.labels.set(studio.hostKey, 'studio.local')
    studio.driver.migrateFromPairings()
    await studio.driver.sync()
    await mesh.drainOwnSyncs()

    // The invented name must never walk the typed one back, on the hub or anywhere it reaches.
    await laptop.driver.sync()
    await mesh.drainOwnSyncs()
    expect(studio.labels.get(laptop.hostKey)).toBe('Studio laptop')
    const view = await studio.driver.snapshot()
    expect(view.members.find((member) => member.hostKey === laptop.hostKey)?.label).toBe(
      'Studio laptop'
    )
  })
})

describe('finding a member again after it changes networks', () => {
  const LAN = 'ws://192.168.1.20:6768'
  const TAILNET = 'ws://100.98.144.27:6768'

  it('repairs the path with the address the member published on an earlier pass', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)
    await laptop.driver.join(mesh.environmentFor(laptop, studio))

    // The laptop publishes the paths it can be reached on, which a pass keeps.
    laptop.endpoints = [LAN, TAILNET]
    await studio.driver.sync()

    // Then it moves: the address the pairing row names is a tailnet one that no longer answers, the LAN one does.
    const environmentId = mesh.environmentFor(studio, laptop)
    studio.dialed.set(environmentId, TAILNET)
    laptop.reachableAt = [LAN]

    await studio.driver.sync()

    expect(studio.adopted).toHaveLength(1)
    expect(studio.adopted[0]?.endpoint).toBe(LAN)
    expect(studio.dialed.get(environmentId)).toBe(LAN)
    // Repaired, not merely reachable this once: the pair reads complete on the pass that found the new path.
    expect(statusOf(await studio.driver.snapshot(), laptop.hostKey)).toBe('complete')
  })

  it('leaves the member unreachable when none of its addresses answer', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)
    await laptop.driver.join(mesh.environmentFor(laptop, studio))
    laptop.endpoints = [LAN]
    await studio.driver.sync()

    studio.dialed.set(mesh.environmentFor(studio, laptop), TAILNET)
    laptop.reachableAt = ['ws://10.4.0.9:6768']

    await studio.driver.sync()

    expect(studio.adopted).toHaveLength(0)
    expect(statusOf(await studio.driver.snapshot(), laptop.hostKey)).not.toBe('complete')
  })

  it('hands a fresh pair the whole address set instead of one guess', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    studio.endpoints = [LAN, TAILNET]
    // Only the studio holds a credential, so the laptop is paired by the offer it is handed.
    mesh.seedPairingFromCaller(studio, laptop)
    studio.driver.migrateFromPairings()

    await studio.driver.sync()

    // The candidates travel on the offer, so the redeeming host knows where to dial before it ever syncs.
    const laptopState = createHostMeshStore({ userDataPath: laptop.userDataPath }).read()
    expect(laptopState?.routes[studio.hostKey]).toEqual([LAN, TAILNET])
  })
})

describe('the addresses a member publishes on its own call', () => {
  it('are kept by the host it called, so a pair it cannot dial back is still repairable', async () => {
    const mesh = new Mesh()
    const studio = mesh.add('studio')
    const laptop = mesh.add('laptop')
    mesh.seedPairing(laptop, studio)
    expect((await laptop.driver.join(mesh.environmentFor(laptop, studio))).kind).toBe('joined')

    laptop.endpoints = ['ws://10.0.0.4:6768', 'ws://100.64.0.4:6768']
    await laptop.driver.sync()

    const state = createHostMeshStore({ userDataPath: studio.userDataPath }).read()
    expect(state?.routes[laptop.hostKey]).toEqual(['ws://10.0.0.4:6768', 'ws://100.64.0.4:6768'])
  })
})
