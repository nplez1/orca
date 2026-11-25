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
  summarizeHostMesh
} from './host-mesh-membership'

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
  it('forgets the members and leaves a tombstone for this host', () => {
    const left = leaveHostMeshGroup(withMembers(['key-a']), { epoch: 5 })

    expect(left.groupId).toBe('')
    expect(left.members).toHaveLength(0)
    expect(left.tombstones).toEqual([{ hostKey: 'key-self', removedBy: 'key-self', epoch: 5 }])
  })
})
