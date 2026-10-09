import { describe, expect, it } from 'vitest'
import type { SessionSummarySnapshot } from '../../../../shared/session-summary-types'
import { resolveSessionSummaryHeaderState } from './session-summary-presentation'

function snapshot(overrides: Partial<SessionSummarySnapshot> = {}): SessionSummarySnapshot {
  return {
    paneKey: 'pane-1',
    status: 'ready',
    facts: null,
    ledger: null,
    seenThrough: 0,
    fold: { running: false, completedChunks: 0, totalChunks: 0 },
    ...overrides
  }
}

describe('resolveSessionSummaryHeaderState', () => {
  it('reports a running fold as in flight regardless of backlog', () => {
    const state = resolveSessionSummaryHeaderState(
      snapshot({ fold: { running: true, completedChunks: 1, totalChunks: 3 } })
    )

    expect(state).toEqual({ hint: 'Updating…', folding: true })
  })

  it('counts the backlog when the fold is idle', () => {
    const state = resolveSessionSummaryHeaderState(
      snapshot({
        facts: {
          paneKey: 'pane-1',
          prompt: 'Refactor the parser',
          messageCount: 40,
          foldedThrough: 32,
          backlogCount: 8
        }
      })
    )

    expect(state).toEqual({ hint: '8 events to catch up on', folding: false })
  })

  it('reads as up to date with no snapshot yet', () => {
    expect(resolveSessionSummaryHeaderState(null)).toEqual({ hint: 'Up to date', folding: false })
  })

  it('names the missing transcript instead of claiming to be up to date', () => {
    const state = resolveSessionSummaryHeaderState(snapshot({ status: 'unavailable' }))

    expect(state).toEqual({ hint: 'No readable transcript', folding: false })
  })

  it('names the failure instead of claiming to be up to date', () => {
    const state = resolveSessionSummaryHeaderState(snapshot({ status: 'failed' }))

    expect(state).toEqual({ hint: 'Could not summarize this session', folding: false })
  })

  // A failed fold over a session already folded once leaves the last good ledger
  // on screen, so the header keeps counting what never got folded.
  it('counts the backlog when a fold failed over an existing ledger', () => {
    const state = resolveSessionSummaryHeaderState(
      snapshot({
        status: 'failed',
        ledger: {
          goal: null,
          plan: [],
          inProgress: null,
          done: [],
          blockers: [],
          decisions: [],
          timeline: [],
          foldedThrough: 4,
          foldedAt: 1
        },
        facts: {
          paneKey: 'pane-1',
          prompt: 'Refactor the parser',
          messageCount: 9,
          foldedThrough: 4,
          backlogCount: 5
        }
      })
    )

    expect(state).toEqual({ hint: '5 events to catch up on', folding: false })
  })

  it('reads as up to date when facts have no backlog', () => {
    const state = resolveSessionSummaryHeaderState(
      snapshot({
        facts: {
          paneKey: 'pane-1',
          prompt: 'Ship the panel',
          messageCount: 12,
          foldedThrough: 12,
          backlogCount: 0
        }
      })
    )

    expect(state).toEqual({ hint: 'Up to date', folding: false })
  })
})
