import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { photonTurnResultText } from './photon-turn-result'

/** A journal row, as the turn-end reader hands them back: item id, body, and the turn it belongs to. */
function item(
  itemId: string,
  body: AgentJournalItemBody,
  turnItemId?: string
): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body,
    ...(turnItemId ? { turnScope: { kind: 'turn' as const, turnItemId } } : {})
  }
}

const turn = (userItemId: string, turnId = 'turn_1'): AgentJournalItemBody => ({
  kind: 'turn',
  turnId,
  state: 'completed',
  userItemId,
  outcome: 'success'
})

const asked = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

const said = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})

const progress = (text: string): AgentJournalItemBody => ({ kind: 'status', text })

const rows = (items: AgentJournalRenderItem[]) => ({
  items,
  openerIds: new Map<string, string>(),
  head: 9
})

describe("a finished turn's answer", () => {
  it('is the turn’s own last assistant message, not a later turn’s', () => {
    const text = photonTurnResultText(
      rows([
        item('u1', asked('is it green?')),
        item('t1', turn('u1')),
        item('a1', said('The build is green.'), 't1'),
        // A next turn opened before this end was read: its prose is not this turn's answer.
        item('a2', said('Working on something else now.'), 't2')
      ])
    )
    expect(text).toBe('The build is green.')
  })

  it('sends nothing for a turn that only made progress, so no progress tick is ever a message', () => {
    const text = photonTurnResultText(
      rows([
        item('t1', turn('u1')),
        item('p1', progress('reading the workflow'), 't1'),
        item('p2', progress('running the tests'), 't1')
      ])
    )
    expect(text).toBeNull()
  })

  it('sends nothing when the rows hold no turn at all', () => {
    expect(photonTurnResultText(rows([]))).toBeNull()
  })

  it('reads the record whose turn id matches, not the newest one, when a second text is queued', () => {
    // Deliveries queue, so turn 2 can write its record before turn 1's end is read — and the read sits
    // behind an `await`. Selecting the newest record and refusing when it is not ours dropped turn 1's
    // answer entirely, which is the send the person was waiting for.
    const text = photonTurnResultText(
      rows([
        item('u1', asked('is it green?')),
        item('t1', turn('u1', 'turn_1')),
        item('a1', said('The build is green.'), 't1'),
        // Turn 2 already started for a second text.
        item('u2', asked('and the tests?')),
        item('t2', turn('u2', 'turn_2'))
      ]),
      'turn_1'
    )
    expect(text).toBe('The build is green.')
  })

  it('sends nothing when the matching turn recorded no answer of its own', () => {
    const text = photonTurnResultText(
      rows([
        item('u1', asked('is it green?')),
        item('t1', turn('u1', 'turn_1')),
        item('u2', asked('and the tests?')),
        item('t2', turn('u2', 'turn_2')),
        item('a2', said('Running them now.'), 't2')
      ]),
      'turn_1'
    )
    expect(text).toBeNull()
  })
})
