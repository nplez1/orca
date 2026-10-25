import { describe, expect, it } from 'vitest'
import { coerceRelayedLedger } from './session-summary-relayed-ledger'

// A paired host updates on its own schedule, so an older one relays the pre-provenance shape:
// facts as bare strings, no window boundary, no reports. Reading that as-is hid every fact.
describe('coerceRelayedLedger', () => {
  it('reads an older host ledger without hiding its facts', () => {
    const ledger = coerceRelayedLedger({
      goal: 'ship the flag',
      plan: ['parse it'],
      inProgress: 'wiring',
      done: ['tested'],
      blockers: [],
      decisions: [],
      timeline: [{ id: 'a', kind: 'milestone', text: 'm', sourceIndex: 3 }],
      foldedThrough: 4,
      foldedAt: 10
    })

    expect(ledger?.goal).toEqual({ text: 'ship the flag', sourceIndex: null })
    expect(ledger?.done).toEqual([{ text: 'tested', sourceIndex: null }])
    expect(ledger?.lastUserMessageIndex).toBeNull()
    expect(ledger?.userMessageCount).toBe(0)
    expect(ledger?.reportFull).toBeNull()
    expect(ledger?.foldedThrough).toBe(4)
  })

  it('keeps a current host ledger intact', () => {
    const ledger = coerceRelayedLedger({
      goal: { text: 'g', sourceIndex: 1 },
      plan: [],
      inProgress: null,
      done: [{ text: 'd', sourceIndex: 9 }],
      blockers: [],
      decisions: [],
      timeline: [],
      reportSince: { text: 's', through: 9 },
      reportFull: { text: 'f', through: 9 },
      lastUserMessageIndex: 5,
      userMessageCount: 2,
      foldedThrough: 9,
      foldedAt: 11
    })

    expect(ledger?.done).toEqual([{ text: 'd', sourceIndex: 9 }])
    expect(ledger?.reportSince).toEqual({ text: 's', through: 9 })
    expect(ledger?.lastUserMessageIndex).toBe(5)
  })

  it('drops entries it cannot read instead of rendering them', () => {
    const ledger = coerceRelayedLedger({
      done: ['kept', '', 42, { text: '' }, { text: 'also kept', sourceIndex: 2 }],
      timeline: [{ id: 'a' }, { id: 'b', kind: 'milestone', text: 'm', sourceIndex: 1 }]
    })

    expect(ledger?.done).toEqual([
      { text: 'kept', sourceIndex: null },
      { text: 'also kept', sourceIndex: 2 }
    ])
    expect(ledger?.timeline.map((entry) => entry.id)).toEqual(['b'])
  })

  it('has no ledger when the host sent none', () => {
    expect(coerceRelayedLedger(null)).toBeNull()
    expect(coerceRelayedLedger('nope')).toBeNull()
  })
})
