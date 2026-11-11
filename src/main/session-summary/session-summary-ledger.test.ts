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

  it('normalizes text and lists with caps', () => {
    const longText = 'x'.repeat(SESSION_SUMMARY_TEXT_MAX_LENGTH * 2)
    const delta = normalizeSessionSummaryDelta({
      goal: { text: `  ${longText}  `, sourceIndex: 2 },
      plan: ['keep', 'keep', '', 42, ...Array.from({ length: 30 }, (_, i) => `step ${i}`)]
    })
    expect(delta?.goal?.text).toHaveLength(SESSION_SUMMARY_TEXT_MAX_LENGTH)
    expect(delta?.goal?.text.endsWith('…')).toBe(true)
    expect(delta?.goal?.sourceIndex).toBe(2)
    expect(delta?.plan).toHaveLength(SESSION_SUMMARY_LIST_MAX_ITEMS)
    expect(delta?.plan?.[0]).toEqual(fact('keep', null))
  })

  // The extract is asked for facts only. A reply that still carries a timeline must not smuggle
  // model-written entries into a projection the ledger derives itself.
  it('drops a timeline an older prompt would have produced', () => {
    const delta = normalizeSessionSummaryDelta({
      done: ['shipped'],
      timeline: [{ kind: 'milestone', text: 'shipped', sourceIndex: 3 }]
    })
    expect(delta).toEqual({ done: [fact('shipped', null)] })
  })
})

describe('mergeSessionSummaryDeltas', () => {
  it('lets the latest chunk revision win scalars and unions lists in order', () => {
    const merged = mergeSessionSummaryDeltas([
      {
        goal: fact('first goal', 1),
        inProgress: fact('a', 1),
        done: [fact('x', 1), fact('y', 2)]
      },
      {
        inProgress: fact('b', 2),
        done: [fact('y', 9), fact('z', 3)]
      },
      // A later chunk with nothing to say about the goal must not erase what an earlier one found.
      { goal: null, done: [fact('z', 4)] }
    ])
    expect(merged.goal).toEqual(fact('first goal', 1))
    expect(merged.inProgress).toEqual(fact('b', 2))
    // y keeps its *first* index: a fact restated later did not become news when it was repeated.
    expect(merged.done).toEqual([fact('x', 1), fact('y', 2), fact('z', 3)])
  })
})

describe('the ledger does not cap its own lists', () => {
  // The old truncation kept the *earliest* twelve at every merge, so the newest facts — the ones a
  // reader opens the pane for — were the ones dropped. The pane caps what it renders instead.
  it('keeps every distinct fact a session produced', () => {
    const many = Array.from({ length: SESSION_SUMMARY_LIST_MAX_ITEMS * 4 }, (_, index) => ({
      text: `milestone ${index}`,
      sourceIndex: index
    }))
    const merged = mergeSessionSummaryDeltas([{ done: many }])
    expect(merged.done).toHaveLength(many.length)
    const applied = applySessionSummaryDelta(emptySessionSummaryLedger(), { done: many }, 50, 1)
    expect(applied.done).toHaveLength(many.length)
    expect(applied.done.at(-1)?.text).toBe(`milestone ${many.length - 1}`)
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

  it('projects the timeline from the facts and the markers and advances foldedThrough', () => {
    const base = { ...emptySessionSummaryLedger(), foldedThrough: 2 }
    const next = applySessionSummaryDelta(
      base,
      {
        done: [{ text: 'shipped the flag', sourceIndex: 4 }],
        blockers: [{ text: 'tests red', sourceIndex: 5 }]
      },
      7,
      100,
      null,
      0,
      {
        markers: [
          { kind: 'user-input', text: 'make it work', sourceIndex: 2 },
          { kind: 'tool-burst', text: '6 tool calls · Read 6', sourceIndex: 3 },
          // Superseded by the blocker at the same index: one failure, one row.
          { kind: 'error', text: 'Bash npm test · FAIL x', sourceIndex: 5 }
        ]
      }
    )
    expect(next.timeline).toEqual([
      { id: 'user-input-2', kind: 'user-input', text: 'make it work', sourceIndex: 2 },
      { id: 'tool-burst-3', kind: 'tool-burst', text: '6 tool calls · Read 6', sourceIndex: 3 },
      { id: 'milestone-4', kind: 'milestone', text: 'shipped the flag', sourceIndex: 4 },
      { id: 'error-5', kind: 'error', text: 'tests red', sourceIndex: 5 }
    ])
    // The marker is still kept: it is what a later projection re-derives from.
    expect(next.markers).toHaveLength(3)
    expect(base.timeline).toEqual([])
    expect(next.foldedThrough).toBe(7)
    expect(next.foldedAt).toBe(100)
  })

  // Re-folding a range after a cache miss used to append its entries a second time. A projection
  // has one answer per (kind, sourceIndex), so applying the same range twice changes nothing.
  it('re-projects to the same timeline when the same range is applied twice', () => {
    const delta = { done: [{ text: 'a', sourceIndex: 3 }] }
    const markers = [{ kind: 'tool-burst' as const, text: '5 tool calls · Read 5', sourceIndex: 2 }]
    const once = applySessionSummaryDelta(emptySessionSummaryLedger(), delta, 7, 100, null, 0, {
      markers
    })
    const twice = applySessionSummaryDelta(once, delta, 7, 200, null, 0, { markers })
    expect(twice.timeline).toEqual(once.timeline)
    expect(twice.markers).toHaveLength(1)
  })

  it('appends a later fold after the entries already there', () => {
    const first = applySessionSummaryDelta(
      emptySessionSummaryLedger(),
      { done: [{ text: 'a', sourceIndex: 1 }] },
      3,
      1
    )
    const second = applySessionSummaryDelta(first, { done: [{ text: 'b', sourceIndex: 4 }] }, 6, 2)
    expect(second.timeline.map((entry) => entry.id)).toEqual(['milestone-1', 'milestone-4'])
    expect(second.timeline[0]).toEqual(first.timeline[0])
  })

  // A chunk whose extract omits sourceIndex anchors all of its facts at the slice's last message,
  // so two milestones can share an index. Duplicate ids are duplicate React keys.
  it('keeps ids unique when two facts of one kind share a message', () => {
    const next = applySessionSummaryDelta(
      emptySessionSummaryLedger(),
      {
        done: [
          { text: 'a', sourceIndex: 9 },
          { text: 'b', sourceIndex: 9 }
        ]
      },
      10,
      1
    )
    expect(next.timeline.map((entry) => entry.id)).toEqual(['milestone-9', 'milestone-9-2'])
  })

  // The timeline is the position its provenance gives it, and the pane's window cannot place an
  // entry with no index at all.
  it('leaves an unanchored fact out of the timeline', () => {
    const next = applySessionSummaryDelta(
      emptySessionSummaryLedger(),
      { done: [{ text: 'no index', sourceIndex: null }] },
      3,
      1
    )
    expect(next.timeline).toEqual([])
  })

  it('records the reader’s place and the reports a fold already wrote', () => {
    const base: ReturnType<typeof emptySessionSummaryLedger> = {
      ...emptySessionSummaryLedger(),
      reportSince: { text: 'since', through: 4 },
      reportFull: {
        headline: 'full',
        sections: [],
        through: 4,
        text: 'full'
      }
    }
    const next = applySessionSummaryDelta(base, { done: [fact('a', 5)] }, 6, 100, 5, 2)
    expect(next.lastUserMessageIndex).toBe(5)
    expect(next.userMessageCount).toBe(2)
    expect(next.reportSince).toEqual({ text: 'since', through: 4 })
    expect(next.reportFull?.text).toBe('full')
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
