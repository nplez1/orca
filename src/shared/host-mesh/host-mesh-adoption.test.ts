import { describe, expect, it } from 'vitest'
import { adoptHostMeshGroup, type HostMeshGroupOffer } from './host-mesh-adoption'
import { addHostMeshMember, createHostMeshState } from './host-mesh-membership'
import { HOST_MESH_MAX_MEMBERS } from './host-mesh-contract'

function stateWith(members: string[], groupId = ''): ReturnType<typeof createHostMeshState> {
  let state = createHostMeshState({ selfKey: 'key-self', groupId, epoch: 3 })
  for (const hostKey of members) {
    state = addHostMeshMember(state, { hostKey, label: hostKey, epoch: 3 }).state
  }
  return state
}

const trusted = (hostKey: string): boolean => ['key-a', 'key-b', 'key-c'].includes(hostKey)

function offer(hostKeys: string[], groupId = 'mesh-offered'): HostMeshGroupOffer {
  return { groupId, epoch: 5, hostKeys }
}

describe('adopting a group another host offers', () => {
  it('takes on a group of machines this host is already paired with', () => {
    const adoption = adoptHostMeshGroup(stateWith(['key-a']), offer(['key-self', 'key-a']), {
      isTrusted: trusted
    })

    expect(adoption.kind).toBe('adopt')
    if (adoption.kind === 'adopt') {
      expect(adoption.state.groupId).toBe('mesh-offered')
      expect(adoption.state.members.map((member) => member.hostKey)).toEqual(['key-a'])
      // Why the epoch moves: taking a new id is a membership change, so this host's view must not be stale.
      expect(adoption.state.epoch).toBe(6)
    }
  })

  it('gives a host that never joined a group one, which is the whole point of an introduction', () => {
    const adoption = adoptHostMeshGroup(stateWith([]), offer(['key-self', 'key-a']), {
      isTrusted: trusted
    })

    expect(adoption.kind).toBe('adopt')
  })

  it('refuses a group naming a machine this host has never paired with', () => {
    // The guard that stops a peer choosing this host's group for it: a stranger in the offer would be a
    // machine this host then mints a credential for.
    expect(
      adoptHostMeshGroup(stateWith(['key-a']), offer(['key-self', 'key-a', 'key-stranger']), {
        isTrusted: trusted
      })
    ).toEqual({ kind: 'refuse', reason: 'group-not-yours' })
  })

  it('takes a newcomer a trusted member vouches for, which is how a machine joins at all', () => {
    const adopted = adoptHostMeshGroup(
      stateWith(['key-a']),
      offer(['key-self', 'key-a', 'key-new']),
      {
        isTrusted: trusted,
        vouched: ['key-new']
      }
    )

    expect(adopted.kind).toBe('adopt')
  })

  it('refuses an offer that does not name this host at all', () => {
    expect(
      adoptHostMeshGroup(stateWith(['key-a']), offer(['key-a', 'key-b']), { isTrusted: trusted })
    ).toEqual({ kind: 'refuse', reason: 'group-not-yours' })
  })

  it('keeps its own group when the offered one is missing a member this host has', () => {
    // Two fleets that share one machine must not merge through it: containment, not overlap.
    expect(
      adoptHostMeshGroup(stateWith(['key-a', 'key-b'], 'mesh-mine'), offer(['key-self', 'key-a']), {
        isTrusted: trusted
      })
    ).toEqual({ kind: 'keep', reason: 'ours-is-bigger' })
  })

  it('says nothing changed when the offer is the group it is already in', () => {
    expect(
      adoptHostMeshGroup(stateWith(['key-a'], 'mesh-offered'), offer(['key-self', 'key-a']), {
        isTrusted: trusted
      })
    ).toEqual({ kind: 'keep', reason: 'already-in-it' })
  })

  it('refuses an empty group id rather than clearing its own', () => {
    expect(
      adoptHostMeshGroup(stateWith(['key-a'], 'mesh-mine'), offer(['key-self', 'key-a'], ''), {
        isTrusted: trusted
      })
    ).toEqual({ kind: 'refuse', reason: 'no-group-offered' })
  })

  it('refuses to adopt past the member cap', () => {
    const full = Array.from({ length: HOST_MESH_MAX_MEMBERS + 1 }, (_, index) => `key-${index}`)
    expect(
      adoptHostMeshGroup(stateWith([]), offer(['key-self', ...full]), {
        isTrusted: () => true
      })
    ).toEqual({ kind: 'refuse', reason: 'at-cap' })
  })
})
