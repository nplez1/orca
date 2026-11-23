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

const turn = (userItemId: string): AgentJournalItemBody => ({
  kind: 'turn',
  turnId: 'turn_1',
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
})
