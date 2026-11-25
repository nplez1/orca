import { describe, expect, it } from 'vitest'
import {
  HOST_MESH_MAX_INTRODUCTIONS_PER_HOUR,
  HOST_MESH_MAX_MEMBERS,
  type HostMeshOfferPayload,
  type HostMeshState
} from './host-mesh-contract'
import {
  DEFAULT_HOST_MESH_SETTINGS,
  decideIntroduce,
  decideJoin,
  membersAwaitingNewcomerOffer,
  type HostMeshSettings,
  type InboundIntroduce,
  type InboundJoin
} from './host-mesh-admission'
import {
  addHostMeshMember,
  createHostMeshState,
  removeHostMeshMember,
  setHostMeshOutboundLink
} from './host-mesh-membership'

const SELF = 'key-self'
const NOW = 1_000_000

function groupOf(keys: readonly string[]): HostMeshState {
  return keys.reduce(
    (state, key, index) =>
      addHostMeshMember(state, { hostKey: key, label: key, epoch: index + 1 }).state,
    createHostMeshState({ selfKey: SELF, groupId: 'group-1', epoch: 1 })
  )
}

function payloadFor(overrides: Partial<HostMeshOfferPayload> = {}): HostMeshOfferPayload {
  return {
    version: 1,
    groupId: 'group-1',
    epoch: 4,
    minterHostKey: 'key-new',
    recipientHostKey: SELF,
    introducedBy: 'key-a',
    offerUrl: 'orca://pair?offer=x',
    endpointCandidates: [],
    expiresAt: NOW + 60_000,
    nonce: 'nonce-1',
    ...overrides
  }
}

function inviteOf(overrides: Partial<InboundIntroduce> = {}): InboundIntroduce {
  return {
    groupId: 'group-1',
    introducerHostKey: 'key-a',
    newcomer: { hostKey: 'key-new', label: 'newcomer' },
    openedPayload: payloadFor(),
    introductionsThisHour: 0,
    now: NOW,
    ...overrides
  }
}

function settingsOf(overrides: Partial<HostMeshSettings> = {}): HostMeshSettings {
  return { ...DEFAULT_HOST_MESH_SETTINGS, ...overrides }
}

describe('admitting an introduced machine', () => {
  it('admits it when every binding holds', () => {
    const decision = decideIntroduce(groupOf(['key-a']), settingsOf(), inviteOf())

    expect(decision.kind).toBe('accept')
  })

  it('refuses when this host is in no group', () => {
    const noGroup = createHostMeshState({ selfKey: SELF, groupId: '', epoch: 1 })

    expect(decideIntroduce(noGroup, settingsOf(), inviteOf())).toEqual({
      kind: 'refuse',
      reason: 'no-group'
    })
  })

  it('refuses an introduction for another group', () => {
    expect(
      decideIntroduce(groupOf(['key-a']), settingsOf(), inviteOf({ groupId: 'other' }))
    ).toEqual({ kind: 'refuse', reason: 'group-mismatch' })
  })

  it('refuses an introduction of this host to itself', () => {
    const decision = decideIntroduce(
      groupOf(['key-a']),
      settingsOf(),
      inviteOf({
        newcomer: { hostKey: SELF, label: 'me' },
        openedPayload: payloadFor({ minterHostKey: SELF })
      })
    )

    expect(decision).toEqual({ kind: 'refuse', reason: 'self-introduction' })
  })

  it('refuses an introducer that is not a member, even if the box is well formed', () => {
    expect(
      decideIntroduce(groupOf(['key-b']), settingsOf(), inviteOf({ introducerHostKey: 'key-a' }))
    ).toEqual({ kind: 'refuse', reason: 'introducer-not-member' })
  })

  it('refuses every introduction when the host does not accept them', () => {
    const decision = decideIntroduce(
      groupOf(['key-a']),
      settingsOf({ acceptIntroductions: false }),
      inviteOf()
    )

    expect(decision).toEqual({ kind: 'refuse', reason: 'introductions-disabled' })
  })

  it('refuses a machine this host removed', () => {
    const removed = removeHostMeshMember(groupOf(['key-a', 'key-new']), {
      hostKey: 'key-new',
      removedBy: SELF,
      epoch: 5
    })

    expect(decideIntroduce(removed, settingsOf(), inviteOf())).toEqual({
      kind: 'refuse',
      reason: 'tombstoned'
    })
  })

  it('refuses at the cap, but not when the newcomer already holds a slot', () => {
    const members = [
      'key-a',
      ...Array.from({ length: HOST_MESH_MAX_MEMBERS - 1 }, (_, i) => `k${i}`)
    ]
    const full = groupOf(members)

    expect(decideIntroduce(full, settingsOf(), inviteOf())).toEqual({
      kind: 'refuse',
      reason: 'at-cap'
    })

    const known = decideIntroduce(
      full,
      settingsOf(),
      inviteOf({
        newcomer: { hostKey: members[1], label: 'known' },
        openedPayload: payloadFor({ minterHostKey: members[1] })
      })
    )
    expect(known.kind).toBe('accept')
  })

  it('refuses a box that did not open, mapping the envelope’s reason', () => {
    expect(
      decideIntroduce(
        groupOf(['key-a']),
        settingsOf(),
        inviteOf({ openedPayload: null, openReason: 'offer-expired' })
      )
    ).toEqual({ kind: 'refuse', reason: 'offer-expired' })
  })

  it('refuses a box addressed to another machine', () => {
    expect(
      decideIntroduce(
        groupOf(['key-a']),
        settingsOf(),
        inviteOf({ openedPayload: payloadFor({ recipientHostKey: 'key-elsewhere' }) })
      )
    ).toEqual({ kind: 'refuse', reason: 'offer-not-addressed-here' })
  })

  it('refuses when the box was minted by a machine other than the declared newcomer', () => {
    const decision = decideIntroduce(
      groupOf(['key-a']),
      settingsOf(),
      inviteOf({ openedPayload: payloadFor({ minterHostKey: 'key-controlled-by-a' }) })
    )

    expect(decision).toEqual({ kind: 'refuse', reason: 'offer-not-from-newcomer' })
  })

  it('refuses when the box was not vouched for by the introducer carrying it', () => {
    const decision = decideIntroduce(
      groupOf(['key-a', 'key-b']),
      settingsOf(),
      inviteOf({ openedPayload: payloadFor({ introducedBy: 'key-b' }) })
    )

    expect(decision).toEqual({ kind: 'refuse', reason: 'offer-not-vouched' })
  })

  it('refuses an expired box even though the envelope also checked it', () => {
    const decision = decideIntroduce(
      groupOf(['key-a']),
      settingsOf(),
      inviteOf({ openedPayload: payloadFor({ expiresAt: NOW }) })
    )

    expect(decision).toEqual({ kind: 'refuse', reason: 'offer-expired' })
  })

  it('refuses past the hourly introduction budget', () => {
    const decision = decideIntroduce(
      groupOf(['key-a']),
      settingsOf(),
      inviteOf({ introductionsThisHour: HOST_MESH_MAX_INTRODUCTIONS_PER_HOUR })
    )

    expect(decision).toEqual({ kind: 'refuse', reason: 'rate-limited' })
  })

  it('asks instead of admitting when the host wants a decision per member', () => {
    const decision = decideIntroduce(
      groupOf(['key-a']),
      settingsOf({ autoAcceptIntroducedMembers: false }),
      inviteOf()
    )

    expect(decision).toEqual({ kind: 'ask', payload: payloadFor() })
  })
})

describe('admitting a join', () => {
  function joinOf(overrides: Partial<InboundJoin> = {}): InboundJoin {
    return {
      joiner: { hostKey: 'key-new', label: 'newcomer' },
      openedPayload: payloadFor(),
      now: NOW,
      ...overrides
    }
  }

  it('admits a joiner whose box names it and is ours', () => {
    expect(decideJoin(groupOf(['key-a']), settingsOf(), joinOf()).kind).toBe('accept')
  })

  it('refuses a box from a machine other than the JOINING one', () => {
    expect(
      decideJoin(
        groupOf(['key-a']),
        settingsOf(),
        joinOf({ openedPayload: payloadFor({ minterHostKey: 'key-other' }) })
      )
    ).toEqual({ kind: 'refuse', reason: 'offer-not-from-joiner' })
  })

  it('refuses a joiner this host removed', () => {
    const removed = removeHostMeshMember(groupOf(['key-a', 'key-new']), {
      hostKey: 'key-new',
      removedBy: SELF,
      epoch: 6
    })

    expect(decideJoin(removed, settingsOf(), joinOf())).toEqual({
      kind: 'refuse',
      reason: 'tombstoned'
    })
  })

  it('refuses at the cap', () => {
    const members = Array.from({ length: HOST_MESH_MAX_MEMBERS }, (_, i) => `k${i}`)
    expect(decideJoin(groupOf(members), settingsOf(), joinOf())).toEqual({
      kind: 'refuse',
      reason: 'at-cap'
    })
  })

  it('refuses a join when this host does not relay for its group', () => {
    expect(
      decideJoin(groupOf(['key-a']), settingsOf({ relayIntroductions: false }), joinOf())
    ).toEqual({ kind: 'refuse', reason: 'joins-disabled' })
  })
})

describe('relay bookkeeping', () => {
  it('lists only members the newcomer is not yet joined to', () => {
    const group = setHostMeshOutboundLink(groupOf(['key-a', 'key-b', 'key-c']), {
      hostKey: 'key-b',
      link: { kind: 'ok' }
    })

    expect(membersAwaitingNewcomerOffer(group, 'key-new')).toEqual(['key-a', 'key-c'])
  })
})
