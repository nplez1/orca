import { describe, expect, it } from 'vitest'
import { AGENT_MODEL_MAX_LENGTH, AGENT_TYPE_MAX_LENGTH } from './agent-status-types'
import {
  agentDescendantRosterToSnapshots,
  findAgentDescendantByProviderSession,
  finishAgentDescendant,
  replaceAgentDescendants,
  upsertAgentDescendant,
  type AgentDescendantRoster
} from './agent-descendant-roster'

describe('Agent descendant roster', () => {
  it('normalizes retained identity fields before storing them', () => {
    const roster: AgentDescendantRoster = new Map()

    upsertAgentDescendant(
      roster,
      ' child-1 ',
      {
        agentType: `reviewer\n${'x'.repeat(AGENT_TYPE_MAX_LENGTH * 2)}`,
        description: 'Review the sidebar lifecycle',
        model: `gpt-model-${'x'.repeat(AGENT_MODEL_MAX_LENGTH * 2)}`,
        state: 'working'
      },
      10
    )

    const snapshot = agentDescendantRosterToSnapshots(roster)?.[0]
    expect([...roster.keys()]).toEqual(['child-1'])
    expect(snapshot?.agentType).toHaveLength(AGENT_TYPE_MAX_LENGTH)
    expect(snapshot?.agentType).not.toContain('\n')
    expect(snapshot?.description).toBe('Review the sidebar lifecycle')
    expect(snapshot?.model).toHaveLength(AGENT_MODEL_MAX_LENGTH)

    finishAgentDescendant(roster, ' child-1 ')
    expect(roster.size).toBe(0)
  })

  it('rejects an id that would normalize to an invisible child', () => {
    const roster: AgentDescendantRoster = new Map()

    upsertAgentDescendant(roster, '   ', { state: 'waiting' }, 10)

    expect(roster.size).toBe(0)
  })
})

describe('a descendant that runs its own agent process', () => {
  it('keeps the provider conversation and finds the child by it', () => {
    const roster: AgentDescendantRoster = new Map()
    upsertAgentDescendant(
      roster,
      'run-1',
      {
        agentType: 'general-purpose',
        providerSession: 'claude-conversation',
        state: 'working'
      },
      10
    )
    expect(findAgentDescendantByProviderSession(roster, 'claude-conversation')).toEqual({
      id: 'run-1',
      providerSession: 'claude-conversation'
    })
    expect(findAgentDescendantByProviderSession(roster, 'someone-else')).toBeNull()
    expect(findAgentDescendantByProviderSession(roster, undefined)).toBeNull()
    expect(agentDescendantRosterToSnapshots(roster)?.[0].providerSession).toBe(
      'claude-conversation'
    )
  })

  it('keeps its tool line when the live set re-upserts it without one', () => {
    const roster: AgentDescendantRoster = new Map()
    upsertAgentDescendant(
      roster,
      'run-1',
      { toolName: 'Bash', toolInput: 'pnpm test', state: 'working' },
      10
    )
    // The pi lane republishes the whole live set on every post, and that payload knows nothing
    // about tools — a replacing write would blank the line the child's own lane just reported.
    replaceAgentDescendants(roster, [{ id: 'run-1', agentType: 'general-purpose' }], 20)
    expect(agentDescendantRosterToSnapshots(roster)?.[0]).toMatchObject({
      toolName: 'Bash',
      toolInput: 'pnpm test'
    })
  })

  it('drops the tool line when its call ends', () => {
    const roster: AgentDescendantRoster = new Map()
    upsertAgentDescendant(
      roster,
      'run-1',
      { toolName: 'Bash', toolInput: 'pnpm test', state: 'working' },
      10
    )
    upsertAgentDescendant(roster, 'run-1', { clearTool: true, state: 'working' }, 20)
    expect(agentDescendantRosterToSnapshots(roster)?.[0].toolName).toBeUndefined()
  })
})
