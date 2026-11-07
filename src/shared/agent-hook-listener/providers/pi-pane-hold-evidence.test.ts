import { describe, expect, it } from 'vitest'
import { normalizeAgentStatusPayload } from '../../agent-status-types'
import { createHookListenerState } from '../listener-state'
import { readPiScheduledWork } from '../pi-scheduled-work'
import {
  applyPiScheduledWorkHold,
  recordPiScheduledWork,
  resolvePiPaneStatus
} from './pi-pane-hold-evidence'

const PANE = 'tab-1:leaf-1'

function field(jobs: unknown): Record<string, unknown> {
  return { scheduled_work: { jobs } }
}

function payload(state: 'working' | 'done' | 'waiting' | 'blocked', extra = {}) {
  return normalizeAgentStatusPayload({ state, prompt: '', agentType: 'pi', ...extra })
}

describe('readPiScheduledWork', () => {
  it('reads the inventory a pi post carries', () => {
    expect(
      readPiScheduledWork(
        field([
          { id: 'loop-1', kind: 'live', next_in_ms: 300_000 },
          { id: 'cold-1', kind: 'cold' }
        ])
      )
    ).toEqual([
      { id: 'loop-1', kind: 'live', nextInMs: 300_000 },
      { id: 'cold-1', kind: 'cold' }
    ])
  })

  it('reports no inventory rather than an empty one when the field is absent', () => {
    // Why: an older build serves neither channel, and absence must read exactly as today.
    expect(readPiScheduledWork({})).toBeNull()
    expect(readPiScheduledWork({ scheduled_work: null })).toBeNull()
    expect(readPiScheduledWork({ scheduled_work: {} })).toBeNull()
  })

  it('drops a fire that is long overdue, because nothing refreshed the evidence', () => {
    expect(
      readPiScheduledWork(field([{ id: 'loop-1', kind: 'live', next_in_ms: -600_000 }]))
    ).toEqual([])
    // Why a grace: the extension re-checks at nextAt + 30s, so a slightly late post is still live.
    expect(
      readPiScheduledWork(field([{ id: 'loop-1', kind: 'live', next_in_ms: -30_000 }]))
    ).toHaveLength(1)
  })

  it('drops a fire beyond the loop extension’s own lifetime', () => {
    expect(
      readPiScheduledWork(field([{ id: 'loop-1', kind: 'live', next_in_ms: 9 * 24 * 3600_000 }]))
    ).toEqual([])
  })

  it('ignores malformed jobs instead of trusting them', () => {
    expect(
      readPiScheduledWork(
        field([
          { id: '', kind: 'live' },
          { id: 'a', kind: 'cron' },
          { id: 'b', kind: 'live', next_in_ms: 'soon' },
          null,
          { id: 'kept', kind: 'live' }
        ])
      )
    ).toEqual([{ id: 'kept', kind: 'live' }])
  })

  it('bounds the inventory the row is asked to trust', () => {
    const jobs = Array.from({ length: 40 }, (_, index) => ({ id: `loop-${index}`, kind: 'live' }))
    expect(readPiScheduledWork(field(jobs))).toHaveLength(20)
  })
})

describe('resolvePiPaneStatus', () => {
  it('holds a finished turn as monitoring while scheduled work is armed', () => {
    expect(resolvePiPaneStatus('done', { runningAgent: false, scheduledWork: true })).toEqual({
      stateName: 'working',
      workingMode: 'monitoring'
    })
  })

  it('leaves a finished turn done with nothing armed', () => {
    expect(resolvePiPaneStatus('done', { runningAgent: false, scheduledWork: false })).toEqual({
      stateName: 'done'
    })
  })

  it('ranks live agent work above the monitor', () => {
    expect(resolvePiPaneStatus('done', { runningAgent: true, scheduledWork: true })).toEqual({
      stateName: 'working'
    })
  })

  it('keeps a lead’s own wait and its live turn', () => {
    expect(resolvePiPaneStatus('waiting', { runningAgent: false, scheduledWork: true })).toEqual({
      stateName: 'waiting'
    })
    expect(resolvePiPaneStatus('working', { runningAgent: false, scheduledWork: true })).toEqual({
      stateName: 'working'
    })
  })
})

describe('applyPiScheduledWorkHold', () => {
  it('publishes the lead’s own verdict as mainAgent so a restatement can recover it', () => {
    const state = createHookListenerState()
    recordPiScheduledWork(state, PANE, field([{ id: 'loop-1', kind: 'live' }]))

    const held = applyPiScheduledWorkHold(state, PANE, payload('done', { turnCompletedAt: 1234 }))

    expect(held?.state).toBe('working')
    expect(held?.workingMode).toBe('monitoring')
    expect(held?.mainAgent).toEqual({ state: 'done', stateStartedAt: 1234 })
  })

  it('clears the hold once the session’s own inventory says nothing is armed', () => {
    const state = createHookListenerState()
    recordPiScheduledWork(state, PANE, field([{ id: 'loop-1', kind: 'live' }]))
    recordPiScheduledWork(state, PANE, field([]))

    expect(applyPiScheduledWorkHold(state, PANE, payload('done'))?.state).toBe('done')
    expect(applyPiScheduledWorkHold(state, PANE, payload('done'))?.workingMode).toBeUndefined()
  })

  it('never holds a session boundary row', () => {
    const state = createHookListenerState()
    recordPiScheduledWork(state, PANE, field([{ id: 'loop-1', kind: 'live' }]))

    const boundary = payload('done', { sessionBoundary: true })

    expect(applyPiScheduledWorkHold(state, PANE, boundary)).toBe(boundary)
  })
})
