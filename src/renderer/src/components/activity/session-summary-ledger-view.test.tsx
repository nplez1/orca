// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummaryLedger } from '../../../../shared/session-summary-types'
import { SessionSummaryLedgerView, windowSinceLastInteraction } from './session-summary-ledger-view'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string, params?: Record<string, unknown>) =>
    (fallback ?? _key).replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(params?.[name] ?? ''))
}))

afterEach(cleanup)

function ledger(overrides: Partial<SessionSummaryLedger> = {}): SessionSummaryLedger {
  return {
    goal: { text: 'Add a --since flag to the export CLI', sourceIndex: 0 },
    plan: [{ text: 'parse the flag', sourceIndex: 0 }],
    inProgress: { text: 'wiring it into the release job', sourceIndex: 41 },
    done: [
      { text: 'flag parsed and tested', sourceIndex: 20 },
      { text: 'docs updated', sourceIndex: 44 }
    ],
    blockers: [],
    decisions: [],
    timeline: [
      { id: 'a', kind: 'milestone', text: 'early milestone', sourceIndex: 10 },
      { id: 'b', kind: 'error', text: 'recent failure', sourceIndex: 45 }
    ],
    reportSince: { text: 'The flag works now; the release wiring is next.', through: 46 },
    reportFull: {
      text: 'Building a --since flag. Parsing is done; release wiring is next.',
      through: 46
    },
    lastUserMessageIndex: 40,
    userMessageCount: 3,
    foldedThrough: 46,
    foldedAt: 1_000,
    ...overrides
  }
}

function snapshotOf(value: SessionSummaryLedger) {
  return {
    paneKey: 'tab-1:leaf-1',
    status: 'ready' as const,
    facts: null,
    ledger: value,
    seenThrough: 0,
    fold: { running: false, completedChunks: 1, totalChunks: 1 }
  }
}

describe('windowSinceLastInteraction', () => {
  it('keeps only what happened after the reader last spoke', () => {
    const window = windowSinceLastInteraction(ledger())
    expect(window.facts.done).toEqual([{ text: 'docs updated', sourceIndex: 44 }])
    expect(window.facts.plan).toEqual([])
    expect(window.timeline.map((entry) => entry.id)).toEqual(['b'])
    expect(window.hiddenCount).toBe(3)
  })

  // A session the reader has only ever started has no earlier work to hide.
  it('windows nothing when the reader has not spoken yet', () => {
    const window = windowSinceLastInteraction(ledger({ lastUserMessageIndex: null }))
    expect(window.facts.done).toHaveLength(2)
    expect(window.hiddenCount).toBe(0)
  })
})

describe('SessionSummaryLedgerView', () => {
  it('leads with the whole-session title and the since-your-message report', () => {
    render(<SessionSummaryLedgerView snapshot={snapshotOf(ledger())} />)

    expect(screen.getByText('Add a --since flag to the export CLI')).toBeTruthy()
    expect(screen.getByText('The flag works now; the release wiring is next.')).toBeTruthy()
    expect(
      screen.queryByText('Building a --since flag. Parsing is done; release wiring is next.')
    ).toBeNull()
  })

  // The pane is a brief: the prose sits directly under the title, and the disclosures are the
  // evidence behind it rather than the first thing the reader sees.
  it('renders the written summary above both disclosures', () => {
    const { container } = render(<SessionSummaryLedgerView snapshot={snapshotOf(ledger())} />)
    const text = container.textContent ?? ''
    const title = text.indexOf('Add a --since flag to the export CLI')
    const report = text.indexOf('The flag works now')
    const ledgerRow = text.indexOf('Ledger')
    const timelineRow = text.indexOf('Timeline')

    expect([title, report, ledgerRow, timelineRow].every((index) => index >= 0)).toBe(true)
    expect(title).toBeLessThan(report)
    expect(report).toBeLessThan(ledgerRow)
    expect(ledgerRow).toBeLessThan(timelineRow)
    expect(timelineRow).toBeLessThan(text.indexOf('Show the full session'))
  })

  // An empty section drops out instead of leaving a row behind, and the fallback keeps the
  // summary's slot rather than closing the gap under the title.
  it('drops empty sections and still ends on the session switch', () => {
    const { container } = render(
      <SessionSummaryLedgerView
        snapshot={snapshotOf(
          ledger({
            reportSince: null,
            inProgress: null,
            done: [{ text: 'old work', sourceIndex: 5 }],
            timeline: [{ id: 'a', kind: 'milestone', text: 'old milestone', sourceIndex: 5 }],
            lastUserMessageIndex: 40
          })
        )}
      />
    )
    const text = container.textContent ?? ''
    const title = text.indexOf('Add a --since flag to the export CLI')
    const fallback = text.indexOf('Nothing has happened since your last message.')

    expect(title).toBeLessThan(fallback)
    expect(fallback).toBeLessThan(text.indexOf('Show the full session'))
    expect(text).not.toContain('Ledger')
    expect(text).not.toContain('Timeline')
  })

  // Both sections start collapsed: the pane opens as a brief, not as a play-by-play.
  it('keeps the ledger and the timeline collapsed until asked', () => {
    render(<SessionSummaryLedgerView snapshot={snapshotOf(ledger())} />)

    expect(screen.queryByText('docs updated')).toBeNull()
    expect(screen.queryByText('recent failure')).toBeNull()
    expect(screen.getByText('1 since your last message')).toBeTruthy()
    expect(screen.getByText('1 events since your last message')).toBeTruthy()
  })

  it('expands the windowed ledger and timeline on click', () => {
    render(<SessionSummaryLedgerView snapshot={snapshotOf(ledger())} />)

    fireEvent.click(screen.getByText('Ledger'))
    expect(screen.getByText('docs updated')).toBeTruthy()
    expect(screen.queryByText('flag parsed and tested')).toBeNull()

    fireEvent.click(screen.getByText('Timeline'))
    expect(screen.getByText('recent failure')).toBeTruthy()
    expect(screen.queryByText('early milestone')).toBeNull()
  })

  // The toggle is a re-render: both reports and both windows are already in the ledger.
  it('switches to the whole session without folding again', () => {
    render(<SessionSummaryLedgerView snapshot={snapshotOf(ledger())} />)

    fireEvent.click(screen.getByText('Show the full session'))

    expect(
      screen.getByText('Building a --since flag. Parsing is done; release wiring is next.')
    ).toBeTruthy()
    fireEvent.click(screen.getByText('Ledger'))
    expect(screen.getByText('flag parsed and tested')).toBeTruthy()
    fireEvent.click(screen.getByText('Timeline'))
    expect(screen.getByText('early milestone')).toBeTruthy()
  })

  // One interaction means the window is the session, so a second report would restate the
  // first: the fold leaves it null and the pane must not offer a switch between them.
  it('offers no session switch when there is only one report', () => {
    render(
      <SessionSummaryLedgerView
        snapshot={snapshotOf(
          ledger({ reportSince: null, lastUserMessageIndex: 0, userMessageCount: 1 })
        )}
      />
    )

    expect(
      screen.getByText('Building a --since flag. Parsing is done; release wiring is next.')
    ).toBeTruthy()
    expect(screen.queryByText('Show the full session')).toBeNull()
  })

  it('says nothing happened since the last message rather than showing a blank pane', () => {
    render(
      <SessionSummaryLedgerView
        snapshot={snapshotOf(
          ledger({
            reportSince: null,
            inProgress: null,
            done: [{ text: 'old work', sourceIndex: 5 }],
            timeline: [{ id: 'a', kind: 'milestone', text: 'old milestone', sourceIndex: 5 }],
            lastUserMessageIndex: 40
          })
        )}
      />
    )

    expect(screen.getByText('Nothing has happened since your last message.')).toBeTruthy()
    expect(screen.getByText('Show the full session')).toBeTruthy()
  })
})
