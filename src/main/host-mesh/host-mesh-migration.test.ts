import { describe, expect, it } from 'vitest'
import { hostMeshGroupIdFor, planHostMeshMigration } from './host-mesh-migration'

const peers = (...hostKeys: string[]): { hostKey: string; label: string }[] =>
  hostKeys.map((hostKey) => ({ hostKey, label: hostKey }))

describe('the group an upgrade creates', () => {
  it('groups this host with every machine it was already paired with', () => {
    const plan = planHostMeshMigration({ selfKey: 'key-self', peers: peers('key-a', 'key-b') })

    expect(plan?.state.groupId).not.toBe('')
    expect(plan?.state.members.map((member) => member.hostKey)).toEqual(['key-a', 'key-b'])
    expect(plan?.peerCount).toBe(2)
  })

  it('claims no link it has not proven, so an unrepaired fleet looks unrepaired', () => {
    const plan = planHostMeshMigration({ selfKey: 'key-self', peers: peers('key-a') })

    // Nothing is dialled or redeemed by the upgrade itself: the pair reads as still awaiting its offer.
    expect(plan?.state.links.outbound['key-a']?.kind).toBe('awaitingOffer')
    // The inbound half is not even awaited: this host has minted nothing, so only the peer can prove it.
    expect(plan?.state.links.inbound['key-a']?.kind).toBe('absent')
  })

  it('gives two machines that saw the same fleet the same group, so they converge without a coordinator', () => {
    const onStudio = planHostMeshMigration({
      selfKey: 'key-studio',
      peers: peers('key-laptop', 'key-vm')
    })
    const onLaptop = planHostMeshMigration({
      selfKey: 'key-studio',
      peers: peers('key-vm', 'key-laptop')
    })

    expect(onStudio?.state.groupId).toBe(onLaptop?.state.groupId)
    expect(hostMeshGroupIdFor(['b', 'a'])).toBe(hostMeshGroupIdFor(['a', 'b']))
  })

  it('gives different fleets different groups', () => {
    expect(hostMeshGroupIdFor(['key-a', 'key-b'])).not.toBe(hostMeshGroupIdFor(['key-a', 'key-c']))
  })

  it('does nothing for a machine with no pairings, rather than inventing an empty group', () => {
    expect(planHostMeshMigration({ selfKey: 'key-self', peers: [] })).toBeNull()
  })

  it('drops this host, duplicates and blanks from what it groups', () => {
    const plan = planHostMeshMigration({
      selfKey: 'key-self',
      peers: [...peers('key-a', 'key-a', ''), { hostKey: 'key-self', label: 'me' }]
    })

    expect(plan?.state.members.map((member) => member.hostKey)).toEqual(['key-a'])
    expect(plan?.peerCount).toBe(1)
  })
})
