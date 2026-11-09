import { describe, expect, it } from 'vitest'
import { AGENT_DESCENDANT_QUIET_REAP_MS } from '../agent-descendant-roster'
import type { AgentSubagentSnapshot } from '../agent-status/contracts/agent-status-subagent-snapshot'
import type { ParsedAgentStatusPayload } from '../agent-status/contracts/agent-status-types'
import { createHookListenerState } from './listener-state'
import {
  carriedReportedChildren,
  paneChildSnapshots,
  rememberReportedChildren,
  resolvePaneHold
} from './pane-child-roster'

const child = (
  id: string,
  state: AgentSubagentSnapshot['state'],
  startedAt = 0
): AgentSubagentSnapshot => ({ id, state, startedAt })

function row(overrides: Partial<ParsedAgentStatusPayload> = {}): ParsedAgentStatusPayload {
  return { state: 'done', prompt: 'delegate', ...overrides }
}

describe('a row resolved from one child roster', () => {
  it('holds a done verdict open for a live child', () => {
    const resolved = resolvePaneHold(row(), 'done', [child('a', 'working')])
    expect(resolved.state).toBe('working')
    expect(resolved.subagents).toEqual([child('a', 'working')])
  })

  it('settles a done verdict beside children that have all finished', () => {
    const resolved = resolvePaneHold(row(), 'done', [child('a', 'idle')])
    expect(resolved.state).toBe('done')
    expect(resolved.subagents).toEqual([child('a', 'idle')])
  })

  it('drops a monitor badge and a session boundary the fold no longer earns', () => {
    const resolved = resolvePaneHold(
      row({ workingMode: 'monitoring', sessionBoundary: true }),
      'done',
      [child('a', 'working')]
    )
    expect(resolved.state).toBe('working')
    expect(resolved.workingMode).toBeUndefined()
    expect(resolved.sessionBoundary).toBeUndefined()
  })

  it('publishes no child list when there is nothing to hold', () => {
    expect(resolvePaneHold(row(), 'done', []).subagents).toBeUndefined()
  })
})

describe('the pane child roster', () => {
  const PANE = 'tab-1:leaf'

  it('unions both rosters in one order, filling a shared id with the reported label', () => {
    const state = createHookListenerState()
    state.descendantRosterByPaneKey.set(
      PANE,
      new Map([
        [
          'tracked',
          {
            agentType: 'researcher',
            state: 'working' as const,
            startedAt: 20,
            lastEventAt: 20
          }
        ]
      ])
    )

    expect(
      paneChildSnapshots(state, PANE, [
        { id: 'reported', state: 'working', startedAt: 10, description: 'search' },
        { id: 'tracked', state: 'working', startedAt: 20, description: 'trace it' }
      ]).map((child) => ({ id: child.id, description: child.description }))
    ).toEqual([
      { id: 'reported', description: 'search' },
      // Why: the tracked entry owns the state and the tool line, but only the reporting lane
      // labelled the child, and a row named by its description beats one named by its type.
      { id: 'tracked', description: 'trace it' }
    ])
  })

  it('carries the reported roster only inside the quiet window', () => {
    const state = createHookListenerState()
    const now = 1_000_000
    rememberReportedChildren(state, PANE, [{ id: 'a', state: 'working', startedAt: 1 }], now)
    expect(carriedReportedChildren(state, PANE, now + 1)).toEqual([
      { id: 'a', state: 'working', startedAt: 1 }
    ])

    // Why: a lane that dies mid-child must not pin the row — the same ceiling the roster itself
    // is reaped on.
    expect(
      carriedReportedChildren(state, PANE, now + AGENT_DESCENDANT_QUIET_REAP_MS + 1)
    ).toBeUndefined()
    expect(state.reportedSubagentsByPaneKey.has(PANE)).toBe(false)
  })

  it('clears the reported roster when the lane says it has none', () => {
    const state = createHookListenerState()
    rememberReportedChildren(state, PANE, [{ id: 'a', state: 'working', startedAt: 1 }], 1)
    rememberReportedChildren(state, PANE, [], 2)
    expect(carriedReportedChildren(state, PANE, 2)).toBeUndefined()
  })
})
