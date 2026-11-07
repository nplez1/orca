import { describe, expect, it } from 'vitest'
import { AGENT_DESCENDANT_QUIET_REAP_MS } from '../agent-descendant-roster'
import type { AgentSubagentSnapshot } from '../agent-status-subagent-snapshot'
import type { ParsedAgentStatusPayload } from '../agent-status-types'
import { paneChildWorkLiveness, paneHoldEvidence } from './descendant-pane-hold-evidence'
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

describe('pane hold evidence', () => {
  it('classifies a published roster into the two facts the fold reads', () => {
    expect(paneHoldEvidence([])).toEqual({ runningAgent: false, waitingAgent: false })
    expect(paneHoldEvidence([child('a', 'working')])).toEqual({
      runningAgent: true,
      waitingAgent: false
    })
    expect(paneHoldEvidence([child('a', 'working'), child('b', 'waiting')])).toEqual({
      runningAgent: true,
      waitingAgent: true
    })
  })

  it('counts every unfinished state as live, and only waiting as a wait', () => {
    // Why: a child Orca cannot classify must hold the pane rather than settle it.
    for (const state of ['working', 'blocked', 'unverifiable'] as const) {
      expect(paneHoldEvidence([child('a', state)])).toEqual({
        runningAgent: true,
        waitingAgent: false
      })
    }
    // Why only `idle`: a snapshot has no `done` — a child the lane cannot classify holds the row.
    expect(paneHoldEvidence([child('a', 'idle')])).toEqual({
      runningAgent: false,
      waitingAgent: false
    })
  })

  it('reads live child work as plain working, never as a monitor', () => {
    // Why: the monitoring badge stays reserved for the Claude session-cron evidence.
    expect(paneChildWorkLiveness({ runningAgent: true, waitingAgent: false })).toBe('working')
    expect(paneChildWorkLiveness({ runningAgent: true, waitingAgent: true })).toBe('waiting')
    expect(paneChildWorkLiveness({ runningAgent: false, waitingAgent: false })).toBeNull()
  })
})

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
