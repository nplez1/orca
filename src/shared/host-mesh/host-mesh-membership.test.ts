import { describe, expect, it } from 'vitest'
import {
  HOST_MESH_MAX_MEMBERS,
  hostMeshPairStatus,
  type HostMeshState,
  type HostMeshSyncPayload
} from './host-mesh-contract'
import {
  addHostMeshMember,
  applyHostMeshSync,
  createHostMeshState,
  hostMeshJoin,
  leaveHostMeshGroup,
  removeHostMeshMember,
  setHostMeshOutboundLink,
  setHostMeshRoutes,
  summarizeHostMesh
} from './host-mesh-membership'
import { setHostMeshName } from './host-mesh-names'

function emptyGroup(): HostMeshState {
  return createHostMeshState({ selfKey: 'key-self', groupId: 'group-1', epoch: 1 })
}

function withMembers(keys: readonly string[]): HostMeshState {
  return keys.reduce(
    (state, key, index) =>
      addHostMeshMember(state, { hostKey: key, label: key, epoch: index + 1 }).state,
    emptyGroup()
  )
}

describe('joining a group', () => {
  it('adds the machine that invited us, and nothing else', () => {
    const joined = hostMeshJoin(emptyGroup(), {
      groupId: 'group-1',
      epoch: 2,
      introducer: { hostKey: 'key-a', label: 'Studio' }
    })

    expect(joined.members.map((member) => member.hostKey)).toEqual(['key-a'])
    expect(joined.members[0].introducedBy).toBeUndefined()
  })

  it('counts a newcomer twice as one member, and takes the newest name for it', () => {
    const once = addHostMeshMember(emptyGroup(), { hostKey: 'key-a', label: 'Studio', epoch: 2 })
    const twice = addHostMeshMember(once.state, { hostKey: 'key-a', label: 'Studio 2', epoch: 3 })

    expect(twice.outcome).toBe('alreadyMember')
    expect(twice.state.members).toHaveLength(1)
    expect(twice.state.members[0].label).toBe('Studio 2')
  })

  it('never adds this host to its own member list', () => {
    const result = addHostMeshMember(emptyGroup(), {
      hostKey: 'key-self',
      label: 'me',
      epoch: 2
    })

    expect(result.outcome).toBe('alreadyMember')
    expect(result.state.members).toHaveLength(0)
  })

  it('refuses a machine that was removed, however often it asks', () => {
    const withA = withMembers(['key-a'])
    const removed = removeHostMeshMember(withA, {
      hostKey: 'key-a',
      removedBy: 'key-self',
      epoch: 5
    })
    const again = addHostMeshMember(removed, { hostKey: 'key-a', label: 'Studio', epoch: 6 })

    expect(again.outcome).toBe('tombstoned')
    expect(again.state.members).toHaveLength(0)
  })

  it('refuses the machine after the cap, and keeps the ones it has', () => {
    let state = emptyGroup()
    for (let index = 0; index < HOST_MESH_MAX_MEMBERS; index += 1) {
      state = addHostMeshMember(state, {
        hostKey: `key-${index}`,
        label: `h${index}`,
        epoch: index + 1
      }).state
    }
    const refused = addHostMeshMember(state, {
      hostKey: 'key-one-too-many',
      label: 'extra',
      epoch: 99
    })

    expect(refused.outcome).toBe('capReached')
    expect(refused.state.members).toHaveLength(HOST_MESH_MAX_MEMBERS)
    expect(summarizeHostMesh(refused.state).atCap).toBe(true)
  })
})

describe('merging another member’s view', () => {
  function syncFrom(overrides: Partial<HostMeshSyncPayload> = {}): HostMeshSyncPayload {
    return {
      version: 1,
      groupId: 'group-1',
      epoch: 9,
      selfKey: 'key-a',
      publicKeyB64: 'pk-a',
      members: [{ hostKey: 'key-b', label: 'Laptop', addedAtEpoch: 4 }],
      tombstones: [],
      links: {},
      ...overrides
    }
  }

  it('learns a machine another member knows', () => {
    const merged = applyHostMeshSync(withMembers(['key-a']), syncFrom())

    expect(merged.members.map((member) => member.hostKey).sort()).toEqual(['key-a', 'key-b'])
  })

  it('ignores a payload for a different group', () => {
    const before = withMembers(['key-a'])
    const merged = applyHostMeshSync(before, syncFrom({ groupId: 'other' }))

    expect(merged).toBe(before)
  })

  it('does not resurrect a machine this host already removed', () => {
    const removed = removeHostMeshMember(withMembers(['key-a', 'key-b']), {
      hostKey: 'key-b',
      removedBy: 'key-self',
      epoch: 5
    })
    const merged = applyHostMeshSync(removed, syncFrom({ epoch: 6 }))

    expect(merged.members.map((member) => member.hostKey)).toEqual(['key-a'])
  })

  it('keeps a removal even when a later sync from another member never heard of it', () => {
    const removed = removeHostMeshMember(withMembers(['key-a', 'key-b']), {
      hostKey: 'key-b',
      removedBy: 'key-a',
      epoch: 5
    })
    const merged = applyHostMeshSync(
      removed,
      syncFrom({
        epoch: 7,
        members: [{ hostKey: 'key-b', label: 'Laptop', addedAtEpoch: 4 }],
        tombstones: []
      })
    )

    expect(merged.members.map((member) => member.hostKey)).toEqual(['key-a'])
    expect(merged.tombstones.map((tombstone) => tombstone.hostKey)).toEqual(['key-b'])
  })

  it('removes a member whose remover was itself removed afterwards', () => {
    const group = withMembers(['key-a'])
    const afterBoth = applyHostMeshSync(
      group,
      syncFrom({
        members: [],
        tombstones: [
          { hostKey: 'key-a', epoch: 8, removedBy: 'key-self' },
          { hostKey: 'key-self', epoch: 9, removedBy: 'key-a' }
        ]
      })
    )

    expect(afterBoth.members).toHaveLength(0)
  })

  it('ignores a third member’s link when a peer claims it', () => {
    const group = withMembers(['key-a', 'key-b'])
    const merged = applyHostMeshSync(group, {
      version: 1,
      groupId: 'group-1',
      epoch: 5,
      selfKey: 'key-a',
      publicKeyB64: 'pk-a',
      members: [],
      tombstones: [],
      // A claim about key-b, made by key-a: it has no standing to state it.
      links: { 'key-b': { outbound: { 'key-self': { kind: 'ok' } }, inbound: {} } }
    })

    // Still the "absent" a freshly added member carries, not the "active" the peer tried to assert.
    expect(merged.links.inbound['key-b']).toEqual({ kind: 'absent' })
  })

  it('never lets a peer write the link this host owns, but does read the peer’s own', () => {
    const group = withMembers(['key-a'])
    const merged = applyHostMeshSync(
      group,
      syncFrom({
        links: {
          'key-a': {
            outbound: { 'key-self': { kind: 'ok' } },
            inbound: {}
          },
          'key-self': {
            outbound: { 'key-a': { kind: 'ok' } },
            inbound: {}
          }
        }
      })
    )

    expect(merged.links.inbound['key-a']).toEqual({ kind: 'active' })
    expect(merged.links.outbound['key-a']).not.toEqual({ kind: 'ok' })
  })
})

describe('summarising the group', () => {
  it('says which pairs are joined at both ends, one end, or not at all', () => {
    let state = withMembers(['key-a', 'key-b', 'key-c'])
    state = setHostMeshOutboundLink(state, { hostKey: 'key-a', link: { kind: 'ok' } })
    state = applyHostMeshSync(state, {
      version: 1,
      groupId: 'group-1',
      epoch: 2,
      selfKey: 'key-a',
      publicKeyB64: 'pk-a',
      members: [],
      tombstones: [],
      links: { 'key-a': { outbound: { 'key-self': { kind: 'ok' } }, inbound: {} } }
    })
    state = setHostMeshOutboundLink(state, { hostKey: 'key-b', link: { kind: 'ok' } })

    const summary = summarizeHostMesh(state)

    expect(summary).toMatchObject({
      memberCount: 3,
      completePairs: 1,
      halfPairs: 1,
      missingPairs: 1,
      atCap: false
    })
    expect(hostMeshPairStatus('key-a', state.links)).toBe('complete')
    expect(hostMeshPairStatus('key-b', state.links)).toBe('half')
    expect(hostMeshPairStatus('key-c', state.links)).toBe('missing')
  })
})

describe('leaving a group', () => {
  it('forgets the members and writes no tombstone that would block rejoining', () => {
    const left = leaveHostMeshGroup(withMembers(['key-a']), { epoch: 5 })

    expect(left.groupId).toBe('')
    expect(left.members).toHaveLength(0)
    // A tombstone naming this host reads as "ejected", so writing one on the way out would make every
    // later rejoin look like that to itself.
    expect(left.tombstones).toEqual([])
  })
})

describe('naming a machine for the group', () => {
  function syncFrom(overrides: Partial<HostMeshSyncPayload> = {}): HostMeshSyncPayload {
    return {
      version: 1,
      groupId: 'group-1',
      epoch: 9,
      selfKey: 'key-a',
      publicKeyB64: 'pk-a',
      members: [{ hostKey: 'key-b', label: 'Laptop', addedAtEpoch: 4 }],
      tombstones: [],
      links: {},
      ...overrides
    }
  }

  it('renames the member row, so an introduction carries the new name rather than the one it arrived with', () => {
    const merged = applyHostMeshSync(
      withMembers(['key-a', 'key-b']),
      syncFrom({ names: { 'key-b': { label: 'Build mini', version: 2 } } })
    )

    expect(merged.members.find((member) => member.hostKey === 'key-b')?.label).toBe('Build mini')
    expect(merged.names['key-b']).toEqual({ label: 'Build mini', version: 2 })
  })

  it('keeps a newer name when an older rename arrives from a machine that has not caught up', () => {
    const named = setHostMeshName(withMembers(['key-a', 'key-b']), {
      hostKey: 'key-b',
      label: 'Build mini'
    })
    const merged = applyHostMeshSync(
      named,
      syncFrom({ names: { 'key-b': { label: 'Mesh host bbbb', version: 1 } } })
    )

    expect(merged.names['key-b']?.label).toBe('Build mini')
  })

  it('converges when two owners rename the same machine at the same version', () => {
    const mine = setHostMeshName(withMembers(['key-a', 'key-b']), {
      hostKey: 'key-b',
      label: 'Studio B'
    })
    const theirs = setHostMeshName(withMembers(['key-a', 'key-b']), {
      hostKey: 'key-b',
      label: 'Studio A'
    })

    // Each host pulls the other's map: whichever word wins locally has to be the same one on both, or the
    // fleet would keep its own answer forever and every host would look right only to itself.
    const fromMine = applyHostMeshSync(theirs, syncFrom({ names: mine.names }))
    const fromTheirs = applyHostMeshSync(mine, syncFrom({ names: theirs.names }))

    expect(fromMine.names['key-b']?.label).toBe(fromTheirs.names['key-b']?.label)
  })

  it('reads a peer that predates naming as saying nothing, not as erasing a name', () => {
    const named = setHostMeshName(withMembers(['key-a', 'key-b']), {
      hostKey: 'key-b',
      label: 'Build mini'
    })
    const merged = applyHostMeshSync(named, syncFrom({ names: undefined }))

    expect(merged.names['key-b']?.label).toBe('Build mini')
  })
})

describe('names arriving from a member', () => {
  function syncFrom(names: HostMeshSyncPayload['names']): HostMeshSyncPayload {
    return {
      version: 1,
      groupId: 'group-1',
      epoch: 9,
      selfKey: 'key-a',
      publicKeyB64: 'pk-a',
      members: [{ hostKey: 'key-b', label: 'Laptop', addedAtEpoch: 4 }],
      tombstones: [],
      links: {},
      names
    }
  }

  it('refuses a name for a machine this group does not have', () => {
    const merged = applyHostMeshSync(
      withMembers(['key-a']),
      syncFrom({ 'key-stranger': { label: 'Not in this group', version: 9 } })
    )

    expect(merged.names['key-stranger']).toBeUndefined()
  })

  it('refuses a version no owner rename could ever outrank, and a label past the cap', () => {
    const merged = applyHostMeshSync(
      withMembers(['key-a', 'key-b']),
      syncFrom({
        'key-b': { label: 'Laptop', version: 1e308 },
        'key-a': { label: 'x'.repeat(300), version: 3 }
      })
    )

    expect(merged.names['key-b']).toBeUndefined()
    expect(merged.names['key-a']).toBeUndefined()
  })

  it('refuses a prototype key rather than letting it become one', () => {
    const polluted: Record<string, { label: string; version: number }> = JSON.parse(
      '{"__proto__": {"label": "polluted", "version": 5}}'
    )
    const merged = applyHostMeshSync(withMembers(['key-a', 'key-b']), syncFrom(polluted))

    expect(Object.getPrototypeOf(merged.names)).toBe(Object.prototype)
    expect(Object.keys(merged.names)).toEqual([])
  })
})

describe('where a member says it can be reached', () => {
  function syncFrom(overrides: Partial<HostMeshSyncPayload> = {}): HostMeshSyncPayload {
    return {
      version: 1,
      groupId: 'group-1',
      epoch: 9,
      selfKey: 'key-a',
      publicKeyB64: 'pk-a',
      members: [{ hostKey: 'key-b', label: 'Laptop', addedAtEpoch: 4 }],
      tombstones: [],
      links: {},
      ...overrides
    }
  }

  it('records the addresses a member published, so a pass can find it after it moves', () => {
    const merged = applyHostMeshSync(
      withMembers(['key-a']),
      syncFrom({ endpoints: ['ws://192.168.1.20:6768', 'ws://100.98.144.27:6768'] })
    )

    expect(merged.routes['key-a']).toEqual(['ws://192.168.1.20:6768', 'ws://100.98.144.27:6768'])
  })

  it('keeps the address a member has left behind as a fallback', () => {
    const before = setHostMeshRoutes(withMembers(['key-a']), {
      hostKey: 'key-a',
      endpoints: ['ws://100.98.144.27:6768']
    })
    const merged = applyHostMeshSync(before, syncFrom({ endpoints: ['ws://192.168.1.20:6768'] }))

    expect(merged.routes['key-a']).toEqual(['ws://192.168.1.20:6768', 'ws://100.98.144.27:6768'])
  })

  it('keeps the routes it had from a peer too old to publish any', () => {
    const before = setHostMeshRoutes(withMembers(['key-a']), {
      hostKey: 'key-a',
      endpoints: ['ws://192.168.1.20:6768']
    })
    const merged = applyHostMeshSync(before, syncFrom())

    expect(merged.routes['key-a']).toEqual(['ws://192.168.1.20:6768'])
  })

  it('forgets a removed member’s routes, so nothing tries to dial it again', () => {
    const routed = setHostMeshRoutes(withMembers(['key-a']), {
      hostKey: 'key-a',
      endpoints: ['ws://192.168.1.20:6768']
    })
    const removed = removeHostMeshMember(routed, {
      hostKey: 'key-a',
      removedBy: 'key-self',
      epoch: 5
    })

    expect(removed.routes['key-a']).toBeUndefined()
  })

  it('leaves the object alone when a member republishes what is already recorded', () => {
    const routed = setHostMeshRoutes(withMembers(['key-a']), {
      hostKey: 'key-a',
      endpoints: ['ws://192.168.1.20:6768']
    })

    expect(
      setHostMeshRoutes(routed, { hostKey: 'key-a', endpoints: ['ws://192.168.1.20:6768'] })
    ).toBe(routed)
  })
})
