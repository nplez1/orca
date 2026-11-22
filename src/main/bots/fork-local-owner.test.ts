import { describe, expect, it } from 'vitest'
import { actsForOwner, type BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { BotActingTurn } from './bot-request-asker'
import { localOwnerAsker, localOwnerTurn } from './fork-local-owner'

const OWNER_TURN: BotActingTurn = {
  rootItemId: null,
  askers: [{ kind: 'owner' }],
  askedBy: [{ kind: 'owner' }],
  request: null,
  actingOnRequestId: null,
  requestIds: [],
  wokenAt: null
}

describe('a local ask', () => {
  it('names the owner of this computer as a person, not a bare owner', () => {
    const asker = localOwnerAsker()

    expect(asker).toMatchObject({ kind: 'person', source: 'local', role: 'owner' })
    expect(actsForOwner([asker])).toBe(true)
  })

  it('opens the turn with that person, for every check and every label that reads it', () => {
    const turn = localOwnerTurn({ ...OWNER_TURN, rootItemId: 'item-1' })

    expect(turn.askers).toEqual([localOwnerAsker()])
    expect(turn.askedBy).toEqual(turn.askers)
    expect(turn.rootItemId).toBe('item-1')
  })

  it('is not what a cloud turn acts for', () => {
    const cloud: BotRequestAsker[] = [{ kind: 'owner' }]

    expect(cloud).not.toEqual([localOwnerAsker()])
  })
})
