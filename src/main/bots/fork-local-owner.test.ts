import { describe, expect, it } from 'vitest'
import { actsForOwner } from '../../shared/bots/bot-acts-for'
import type { BotActingTurn } from './bot-request-asker'
import {
  botMailCallerOf,
  localOwnerAsker,
  localOwnerTurn,
  type BotMailContext
} from './fork-local-owner'

/** A session behind the send, as a chat or a worker has. */
function callerSession(): BotMailContext['orchestrationCaller'] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper reads only sessionId, which the fixture sets.
  const sessionId = '11111111-1111-4111-8111-111111111111' as never
  return {
    address: 'orca_session_id:11111111-1111-4111-8111-111111111111',
    terminalHandle: null,
    paneKey: null,
    orcaSessionId: sessionId,
    sessionId,
    workspaceId: 'w'
  }
}

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
    expect(actsForOwner(asker ? [asker] : [])).toBe(true)
  })

  it('opens the turn with that person, for every check and every label that reads it', () => {
    const turn = localOwnerTurn({ ...OWNER_TURN, rootItemId: 'item-1' })

    expect(turn.askers).toEqual([localOwnerAsker()])
    expect(turn.askedBy).toEqual(turn.askers)
    expect(turn.rootItemId).toBe('item-1')
  })

  it("is only this computer's own shell, never another machine's mail", () => {
    const caller = (context: {
      orchestrationCaller?: BotMailContext['orchestrationCaller']
      callerScope?: BotMailContext['callerScope']
    }) => botMailCallerOf(context, OWNER_TURN)

    // The owner's own shell: no session behind it, and a caller no transport proved to be a device.
    expect(caller({}).turn.askers).toEqual([localOwnerAsker()])
    expect(caller({ callerScope: { kind: 'owner' } }).turn.askers).toEqual([localOwnerAsker()])
    // A paired computer's mail arrives with no session either, and is not this shell's owner.
    expect(caller({ callerScope: { kind: 'runtime-paired', grants: [] } }).turn.askers).toEqual([
      { kind: 'owner' }
    ])
    // A phone's send, and a send with a session behind it, are not the shell's owner either.
    expect(caller({ callerScope: { kind: 'mobile' } }).turn.askers).toEqual([{ kind: 'owner' }])
    expect(caller({ orchestrationCaller: callerSession() }).turn.askers).toEqual([
      { kind: 'owner' }
    ])
  })
})
