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
