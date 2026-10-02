import { describe, expect, it } from 'vitest'
import {
  applySessionSummaryDelta,
  emptySessionSummaryLedger,
  mergeSessionSummaryDeltas,
  normalizeSessionSummaryDelta
} from './session-summary-ledger'
import {
  SESSION_SUMMARY_LIST_MAX_ITEMS,
  SESSION_SUMMARY_TEXT_MAX_LENGTH
} from '../../shared/session-summary-types'

describe('normalizeSessionSummaryDelta', () => {
  it('rejects non-objects and empty deltas', () => {
    expect(normalizeSessionSummaryDelta(null)).toBeNull()
    expect(normalizeSessionSummaryDelta('{"goal": "x"}')).toBeNull()
    expect(normalizeSessionSummaryDelta({})).toBeNull()
    expect(normalizeSessionSummaryDelta({ unknownField: 1 })).toBeNull()
  })

  it('distinguishes absent fields from explicit null', () => {
    const delta = normalizeSessionSummaryDelta({ goal: null })
    expect(delta).toEqual({ goal: null })
    expect(normalizeSessionSummaryDelta({ done: ['a'] })).toEqual({ done: ['a'] })
  })

  it('normalizes text, lists, and timeline entries with caps', () => {
    const longText = 'x'.repeat(SESSION_SUMMARY_TEXT_MAX_LENGTH * 2)
    const delta = normalizeSessionSummaryDelta({
      goal: `  ${longText}  `,
      plan: ['keep', 'keep', '', 42, ...Array.from({ length: 30 }, (_, i) => `step ${i}`)],
      timeline: [
        { kind: 'milestone', text: 'shipped', sourceIndex: 3 },
        { kind: 'bogus-kind', text: 'dropped', sourceIndex: 1 },
        { kind: 'error', text: '', sourceIndex: 1 },
        { kind: 'error', text: 'boom', sourceIndex: -5 }
      ]
    })
    expect(delta?.goal).toHaveLength(SESSION_SUMMARY_TEXT_MAX_LENGTH)
    expect(delta?.goal?.endsWith('…')).toBe(true)
    expect(delta?.plan).toHaveLength(SESSION_SUMMARY_LIST_MAX_ITEMS)
    expect(delta?.plan?.[0]).toBe('keep')
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
        goal: 'first goal',
        inProgress: 'a',
        done: ['x', 'y'],
        timeline: [{ kind: 'milestone', text: 't1', sourceIndex: 1 }]
      },
      {
        inProgress: 'b',
        done: ['y', 'z'],
        timeline: [{ kind: 'decision', text: 't2', sourceIndex: 2 }]
      },
      { goal: null, done: ['z'] }
    ])
    expect(merged.goal).toBeNull()
    expect(merged.inProgress).toBe('b')
    expect(merged.done).toEqual(['x', 'y', 'z'])
    expect(merged.timeline).toHaveLength(2)
    expect(merged.timeline?.[0].text).toBe('t1')
    expect(merged.timeline?.[1].text).toBe('t2')
  })
})

describe('applySessionSummaryDelta', () => {
  it('leaves absent fields untouched and clears on explicit null', () => {
    const base = { ...emptySessionSummaryLedger(), goal: 'old', inProgress: 'working' }
    const untouched = applySessionSummaryDelta(base, { done: ['a'] }, 5, 100)
    expect(untouched.goal).toBe('old')
    expect(untouched.inProgress).toBe('working')
    const cleared = applySessionSummaryDelta(base, { goal: null }, 5, 100)
    expect(cleared.goal).toBeNull()
    expect(cleared.inProgress).toBe('working')
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
})
