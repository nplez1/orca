// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummarySnapshot } from '../../../../shared/session-summary-types'
import SessionSummaryPane from './SessionSummaryPane'

const mocks = vi.hoisted(() => {
  const state: {
    paneKey: string | null
    snapshot: SessionSummarySnapshot | null
    hasBridge: boolean
    executionHostId: string | null
    hostSupported: boolean
  } = {
    paneKey: null,
    snapshot: null,
    hasBridge: true,
    executionHostId: 'local',
    hostSupported: true
  }
  return state
})

vi.mock('./session-summary-subject', () => ({
  useSessionSummaryPaneKey: () => mocks.paneKey,
  useSessionSummaryExecutionHostId: () => mocks.executionHostId,
  useSessionSummaryHostSupported: () => mocks.hostSupported,
  hasSessionSummaryBridge: () => mocks.hasBridge
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
  beforeEach(() => {
    mocks.paneKey = null
    mocks.snapshot = null
    mocks.hasBridge = true
    mocks.executionHostId = 'local'
    mocks.hostSupported = true
  })

  it('asks the user to focus an agent when none is focused', () => {
    mocks.paneKey = null
    mocks.snapshot = null
    mocks.hasBridge = true

    const markup = renderToStaticMarkup(<SessionSummaryPane isVisible />)

    expect(markup).toContain('Focus an agent session to see its summary.')
    expect(markup).toContain('lucide-info')
  })

  // Not "nothing is focused": the workspace's host is one this build cannot place.
  it('names an unplaceable host rather than asking the user to focus an agent', () => {
    mocks.paneKey = null
    mocks.snapshot = null
    mocks.hostSupported = false

    const markup = renderToStaticMarkup(<SessionSummaryPane isVisible />)

    expect(markup).toContain('Session summaries are not available for a workspace on this host.')
    expect(markup).not.toContain('Focus an agent session to see its summary.')
  })

  it('says so when this window has no summary bridge at all', () => {
    mocks.paneKey = 'tab-1:leaf-1'
    mocks.snapshot = null
    mocks.hasBridge = false

    expect(renderToStaticMarkup(<SessionSummaryPane isVisible />)).toContain(
      'Session summaries are not available in this window.'
    )
  })

  it('renders the brief for the resolved pane', () => {
    mocks.paneKey = PANE_KEY
    mocks.snapshot = readySnapshot()

    const markup = renderToStaticMarkup(<SessionSummaryPane isVisible />)

    expect(markup).toContain('Session summary')
    expect(markup).toContain('Up to date')
    expect(markup).toContain('lucide-sticky-note')
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

  // #135: a readable session whose fold produced nothing must not say "Up to date"
  // over a blank body — that is the state the pane reported with no ledger at all.
  it('does not claim to be up to date when there is no ledger', () => {
    mocks.paneKey = PANE_KEY
    mocks.snapshot = readySnapshot({ ledger: null, status: 'unavailable' })

    const markup = renderToStaticMarkup(<SessionSummaryPane isVisible />)

    expect(markup).not.toContain('Up to date')
    expect(markup).toContain('No readable transcript')
  })

  it('names a host that cannot produce a brief instead of asking the user to focus', () => {
    mocks.paneKey = PANE_KEY
    mocks.snapshot = readySnapshot({ ledger: null, status: 'unsupported-host' })

    const markup = renderToStaticMarkup(<SessionSummaryPane isVisible />)

    expect(markup).toContain('Session summaries are not available for a workspace on this host.')
    expect(markup).not.toContain('Focus an agent session to see its summary.')
  })

  it('shows why a fold failed, not just that it did', () => {
    mocks.paneKey = PANE_KEY
    mocks.snapshot = readySnapshot({
      ledger: null,
      status: 'failed',
      error: 'Not connected to target-1'
    })

    const markup = renderToStaticMarkup(<SessionSummaryPane isVisible />)

    expect(markup).toContain('Could not summarize this session.')
    expect(markup).toContain('Not connected to target-1')
  })

  // A paired host that predates host folding answers with a remedy, not a failure.
  it('tells the reader to update a paired host that cannot fold', () => {
    mocks.paneKey = PANE_KEY
    mocks.snapshot = readySnapshot({
      ledger: null,
      status: 'failed',
      error: 'host-outdated'
    })

    const markup = renderToStaticMarkup(<SessionSummaryPane isVisible />)

    expect(markup).toContain('Update Orca there to summarize its sessions.')
    expect(markup).not.toContain('Could not summarize this session.')
  })
})
