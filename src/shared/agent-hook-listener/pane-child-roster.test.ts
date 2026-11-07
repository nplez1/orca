import { describe, expect, it } from 'vitest'
import type { AgentSubagentSnapshot } from '../agent-status-subagent-snapshot'
import type { ParsedAgentStatusPayload } from '../agent-status-types'
import { paneChildWorkLiveness, paneHoldEvidence } from './descendant-pane-hold-evidence'
import { resolvePaneHold } from './pane-child-roster'

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
