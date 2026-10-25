import { describe, expect, it } from 'vitest'
import {
  applySessionSummaryDelta,
  emptySessionSummaryLedger,
  hasProducedLedger,
  mergeSessionSummaryDeltas,
  normalizeSessionSummaryDelta
} from './session-summary-ledger'
import {
  SESSION_SUMMARY_LIST_MAX_ITEMS,
  SESSION_SUMMARY_TEXT_MAX_LENGTH
} from '../../shared/session-summary-types'

const fact = (text: string, sourceIndex: number | null) => ({ text, sourceIndex })
const slice = (from: number, to: number) => ({ min: from, max: to, fallback: to })

describe('normalizeSessionSummaryDelta', () => {
  it('rejects non-objects and empty deltas', () => {
    expect(normalizeSessionSummaryDelta(null)).toBeNull()
    expect(normalizeSessionSummaryDelta('{"goal": "x"}')).toBeNull()
    expect(normalizeSessionSummaryDelta({})).toBeNull()
    expect(normalizeSessionSummaryDelta({ unknownField: 1 })).toBeNull()
  })

  it('distinguishes absent fields from explicit null', () => {
    expect(normalizeSessionSummaryDelta({ goal: null })).toEqual({ goal: null })
    expect(normalizeSessionSummaryDelta({ done: ['a'] })).toEqual({
      done: [fact('a', null)]
    })
  })

  // Why the fallback: the "since your last message" window is computed from these indexes, so a
  // fact the model left unindexed is still placed — at the slice's last message, because a slice
  // usually opens with the reader's own message and placing facts there hides the whole slice.
  it('places an unindexed fact at the slice it was read from', () => {
    const delta = normalizeSessionSummaryDelta({ done: ['no index'] }, slice(10, 49))
    expect(delta?.done).toEqual([fact('no index', 49)])
  })

  it('keeps a fact index the model did supply', () => {
    const delta = normalizeSessionSummaryDelta(
      { done: [fact('indexed', 40), { text: 'unindexed', sourceIndex: -1 }] },
      slice(10, 49)
    )
    expect(delta?.done).toEqual([fact('indexed', 40), fact('unindexed', 49)])
  })

  // A slice-relative answer would put the whole slice before the reader's last message.
  it('rejects an index outside the slice instead of trusting it', () => {
    const delta = normalizeSessionSummaryDelta(
      { done: [fact('slice relative', 0), fact('past the end', 500)] },
      slice(10, 49)
    )
    expect(delta?.done).toEqual([fact('slice relative', 49), fact('past the end', 49)])
  })

  it('normalizes text, lists, and timeline entries with caps', () => {
    const longText = 'x'.repeat(SESSION_SUMMARY_TEXT_MAX_LENGTH * 2)
    const delta = normalizeSessionSummaryDelta({
      goal: { text: `  ${longText}  `, sourceIndex: 2 },
      plan: ['keep', 'keep', '', 42, ...Array.from({ length: 30 }, (_, i) => `step ${i}`)],
      timeline: [
        { kind: 'milestone', text: 'shipped', sourceIndex: 3 },
        { kind: 'bogus-kind', text: 'dropped', sourceIndex: 1 },
        { kind: 'error', text: '', sourceIndex: 1 },
        { kind: 'error', text: 'boom', sourceIndex: -5 }
      ]
    })
    expect(delta?.goal?.text).toHaveLength(SESSION_SUMMARY_TEXT_MAX_LENGTH)
    expect(delta?.goal?.text.endsWith('…')).toBe(true)
    expect(delta?.goal?.sourceIndex).toBe(2)
    expect(delta?.plan).toHaveLength(SESSION_SUMMARY_LIST_MAX_ITEMS)
    expect(delta?.plan?.[0]).toEqual(fact('keep', null))
    expect(delta?.timeline).toEqual([
      { kind: 'milestone', text: 'shipped', sourceIndex: 3 },
      { kind: 'error', text: 'boom', sourceIndex: 0 }
    ])
  })
})

describe('mergeSessionSummaryDeltas', () => {
  it('lets the latest chunk revision win scalars and unions lists in order', () => {
    const merged = mergeSessionSummaryDeltas([
      {
        goal: fact('first goal', 1),
        inProgress: fact('a', 1),
        done: [fact('x', 1), fact('y', 2)],
        timeline: [{ kind: 'milestone', text: 't1', sourceIndex: 1 }]
      },
      {
        inProgress: fact('b', 2),
        done: [fact('y', 9), fact('z', 3)],
        timeline: [{ kind: 'decision', text: 't2', sourceIndex: 2 }]
      },
      // A later chunk with nothing to say about the goal must not erase what an earlier one found.
      { goal: null, done: [fact('z', 4)] }
    ])
    expect(merged.goal).toEqual(fact('first goal', 1))
    expect(merged.inProgress).toEqual(fact('b', 2))
    // y keeps its *first* index: a fact restated later did not become news when it was repeated.
    expect(merged.done).toEqual([fact('x', 1), fact('y', 2), fact('z', 3)])
    expect(merged.timeline).toHaveLength(2)
    expect(merged.timeline?.[0].text).toBe('t1')
    expect(merged.timeline?.[1].text).toBe('t2')
  })
})

describe('applySessionSummaryDelta', () => {
  it('leaves absent fields untouched and clears on explicit null', () => {
    const base = {
      ...emptySessionSummaryLedger(),
      goal: fact('old', 1),
      inProgress: fact('working', 2)
    }
    const untouched = applySessionSummaryDelta(base, { done: [fact('a', 3)] }, 5, 100)
    expect(untouched.goal).toEqual(fact('old', 1))
    expect(untouched.inProgress).toEqual(fact('working', 2))
    // A goal is replaced, never unset: a later chunk with no opinion must not erase the title.
    const cleared = applySessionSummaryDelta(base, { goal: null }, 5, 100)
    expect(cleared.goal).toEqual(fact('old', 1))
    const replaced = applySessionSummaryDelta(base, { goal: fact('new', 4) }, 5, 100)
    expect(replaced.goal).toEqual(fact('new', 4))
    expect(replaced.inProgress).toEqual(fact('working', 2))
  })

  it('appends to the timeline without rewriting history and advances foldedThrough', () => {
    const base = {
      ...emptySessionSummaryLedger(),
      timeline: [{ id: 'entry-0', kind: 'milestone' as const, text: 't1', sourceIndex: 1 }],
      foldedThrough: 2
    }
    const next = applySessionSummaryDelta(
      base,
      { timeline: [{ kind: 'error' as const, text: 't2', sourceIndex: 3 }] },
      7,
      100
    )
    expect(next.timeline.map((entry) => entry.text)).toEqual(['t1', 't2'])
    expect(base.timeline).toHaveLength(1)
    expect(next.foldedThrough).toBe(7)
    expect(next.foldedAt).toBe(100)
  })

  it('records the reader’s place and the reports a fold already wrote', () => {
    const base: ReturnType<typeof emptySessionSummaryLedger> = {
      ...emptySessionSummaryLedger(),
      reportSince: { text: 'since', through: 4 },
      reportFull: { text: 'full', through: 4 }
    }
    const next = applySessionSummaryDelta(base, { done: [fact('a', 5)] }, 6, 100, 5, 2)
    expect(next.lastUserMessageIndex).toBe(5)
    expect(next.userMessageCount).toBe(2)
    expect(next.reportSince).toEqual({ text: 'since', through: 4 })
    expect(next.reportFull).toEqual({ text: 'full', through: 4 })
  })
})

describe('hasProducedLedger', () => {
  it('is false for a ledger no fold ever wrote', () => {
    expect(hasProducedLedger(emptySessionSummaryLedger())).toBe(false)
  })

  it('is true once a fold has advanced the cursor', () => {
    expect(
      hasProducedLedger({ ...emptySessionSummaryLedger(), foldedThrough: 3, foldedAt: 1 })
    ).toBe(true)
  })

  it('is true when a fold kept a timeline but no cursor', () => {
    expect(
      hasProducedLedger({
        ...emptySessionSummaryLedger(),
        timeline: [{ id: '1', kind: 'milestone', text: 'x', sourceIndex: 0 }]
      })
    ).toBe(true)
  })
})
