// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSummarySnapshot } from '../../../../shared/session-summary-types'
import SessionSummaryPane from './SessionSummaryPane'

const mocks = vi.hoisted(() => {
  const state: { paneKey: string | null; snapshot: SessionSummarySnapshot | null } = {
    paneKey: null,
    snapshot: null
  }
  return state
})

vi.mock('./session-summary-subject', () => ({
  useSessionSummaryPaneKey: () => mocks.paneKey
}))
vi.mock('@/components/activity/use-session-summary', () => ({
  useSessionSummary: () => mocks.snapshot
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string) => fallback ?? _key
}))

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function readySnapshot(overrides: Partial<SessionSummarySnapshot> = {}): SessionSummarySnapshot {
  return {
    paneKey: PANE_KEY,
    status: 'ready',
    facts: null,
    ledger: {
      goal: 'Ship the summary pane',
      plan: [],
      inProgress: 'Wiring the right-sidebar tab',
      done: ['Moved the ledger view out of the activity strip'],
      blockers: [],
      decisions: [],
      timeline: [],
      foldedThrough: 4,
      foldedAt: 1_000
    },
    seenThrough: 0,
    fold: { running: false, completedChunks: 1, totalChunks: 1 },
    ...overrides
  }
}

describe('SessionSummaryPane', () => {
  it('asks the user to focus an agent when none is focused', () => {
    mocks.paneKey = null
    mocks.snapshot = null

    const markup = renderToStaticMarkup(<SessionSummaryPane isVisible />)

    expect(markup).toContain('Focus an agent session to see its summary.')
    expect(markup).toContain('lucide-info')
  })

  it('renders the brief for the resolved pane', () => {
    mocks.paneKey = PANE_KEY
    mocks.snapshot = readySnapshot()

    const markup = renderToStaticMarkup(<SessionSummaryPane isVisible />)

    expect(markup).toContain('Session summary')
    expect(markup).toContain('Up to date')
    expect(markup).toContain('lucide-info')
    expect(markup).toContain('Wiring the right-sidebar tab')
    expect(markup).toContain('Moved the ledger view out of the activity strip')
  })

  it('reports a running fold in the header', () => {
    mocks.paneKey = PANE_KEY
    mocks.snapshot = readySnapshot({
      ledger: null,
      status: 'folding',
      fold: { running: true, completedChunks: 1, totalChunks: 3 }
    })

    expect(renderToStaticMarkup(<SessionSummaryPane isVisible />)).toContain('Updating…')
  })

  it('explains a session with no readable transcript', () => {
    mocks.paneKey = PANE_KEY
    mocks.snapshot = readySnapshot({ ledger: null, status: 'unavailable' })

    expect(renderToStaticMarkup(<SessionSummaryPane isVisible />)).toContain(
      'No readable transcript for this session yet.'
    )
  })
})
