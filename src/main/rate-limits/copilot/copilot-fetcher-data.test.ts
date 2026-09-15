import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCopilotEntitlementSnapshot,
  buildCopilotSnapshot,
  COPILOT_MONTHLY_WINDOW_MINUTES,
  makeCopilotError,
  readNextMonthStartUtc
} from './copilot-fetcher-data'

// A mid-month instant, so the next-month boundary is unambiguous.
const FROZEN_NOW = Date.parse('2026-07-04T12:00:00.000Z')
const NEXT_MONTH_START = Date.UTC(2026, 7, 1)

function userEntitlement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    quota_reset_date_utc: '2026-08-01T00:00:00.000Z',
    quota_snapshots: {
      premium_interactions: {
        credits_used: 264_518,
        entitlement: 1_000_000
      }
    },
    ...overrides
  }
}

describe('readNextMonthStartUtc', () => {
  it.each([
    ['a mid-month instant', '2026-07-04T12:00:00.000Z', Date.UTC(2026, 7, 1)],
    ['the first instant of a month', '2026-07-01T00:00:00.000Z', Date.UTC(2026, 7, 1)],
    ['the last instant of a month', '2026-07-31T23:59:59.999Z', Date.UTC(2026, 7, 1)],
    ['the year boundary', '2026-12-31T23:30:00.000Z', Date.UTC(2027, 0, 1)]
  ])('returns the first instant of the next UTC month for %s', (_label, iso, expected) => {
    expect(readNextMonthStartUtc(Date.parse(iso))).toBe(expected)
  })

  it('reads the current clock when no instant is given', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FROZEN_NOW))
    try {
      expect(readNextMonthStartUtc()).toBe(NEXT_MONTH_START)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('buildCopilotEntitlementSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FROZEN_NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the entitlement credits as the allowance and the monthly window', () => {
    const snapshot = buildCopilotEntitlementSnapshot(userEntitlement())

    expect(snapshot).toEqual({
      provider: 'copilot',
      session: null,
      weekly: null,
      monthly: {
        usedPercent: 26.4518,
        windowMinutes: COPILOT_MONTHLY_WINDOW_MINUTES,
        resetsAt: Date.UTC(2026, 7, 1),
        resetDescription: null
      },
      allowance: {
        unit: { kind: 'count', label: 'AI credits' },
        used: 264_518,
        limit: 1_000_000,
        resetsAt: Date.UTC(2026, 7, 1)
      },
      updatedAt: FROZEN_NOW,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    })
    expect(snapshot?.monthly?.windowMinutes).toBe(43_200)
  })

  it('reads numeric strings, because GitHub returns some counters that way', () => {
    const snapshot = buildCopilotEntitlementSnapshot(
      userEntitlement({
        quota_snapshots: { premium_interactions: { credits_used: '250', entitlement: '1000' } }
      })
    )

    expect(snapshot?.allowance).toEqual({
      unit: { kind: 'count', label: 'AI credits' },
      used: 250,
      limit: 1_000,
      resetsAt: Date.UTC(2026, 7, 1)
    })
    expect(snapshot?.monthly?.usedPercent).toBe(25)
  })

  it('falls back to the next month boundary when the payload reports no reset date', () => {
    const missing = buildCopilotEntitlementSnapshot(
      userEntitlement({ quota_reset_date_utc: undefined })
    )
    const unreadable = buildCopilotEntitlementSnapshot(
      userEntitlement({ quota_reset_date_utc: 'not-a-date' })
    )

    expect(missing?.allowance?.resetsAt).toBe(NEXT_MONTH_START)
    expect(unreadable?.allowance?.resetsAt).toBe(NEXT_MONTH_START)
  })

  it('clamps a runaway percentage to 100 and a negative one to 0', () => {
    const over = buildCopilotEntitlementSnapshot(
      userEntitlement({
        quota_snapshots: {
          premium_interactions: { credits_used: 2_000_000, entitlement: 1_000_000 }
        }
      })
    )
    const under = buildCopilotEntitlementSnapshot(
      userEntitlement({
        quota_snapshots: { premium_interactions: { credits_used: -5, entitlement: 1_000_000 } }
      })
    )

    expect(over?.monthly?.usedPercent).toBe(100)
    expect(under?.monthly?.usedPercent).toBe(0)
  })

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['a missing quota_snapshots object', {}],
    ['a null quota_snapshots object', { quota_snapshots: null }],
    ['a missing premium_interactions entry', { quota_snapshots: {} }],
    ['a non-object premium_interactions entry', { quota_snapshots: { premium_interactions: 7 } }],
    ['a missing credits_used', { quota_snapshots: { premium_interactions: { entitlement: 100 } } }],
    ['a missing entitlement', { quota_snapshots: { premium_interactions: { credits_used: 5 } } }],
    [
      'a non-finite credits_used',
      { quota_snapshots: { premium_interactions: { credits_used: 'abc', entitlement: 100 } } }
    ],
    [
      'a zero entitlement',
      { quota_snapshots: { premium_interactions: { credits_used: 5, entitlement: 0 } } }
    ],
    [
      'a negative entitlement',
      { quota_snapshots: { premium_interactions: { credits_used: 5, entitlement: -1 } } }
    ]
  ])('returns null for %s rather than inventing a quota', (_label, payload) => {
    expect(buildCopilotEntitlementSnapshot(payload)).toBeNull()
  })
})

describe('copilot snapshot factories', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FROZEN_NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks a successful read as ok with the monthly window and the allowance', () => {
    const snapshot = buildCopilotSnapshot({
      allowance: {
        unit: { kind: 'count', label: 'AI credits' },
        used: 400_000,
        limit: 1_000_000,
        resetsAt: NEXT_MONTH_START
      },
      window: {
        usedPercent: 40,
        windowMinutes: COPILOT_MONTHLY_WINDOW_MINUTES,
        resetsAt: NEXT_MONTH_START,
        resetDescription: null
      }
    })

    expect(snapshot).toEqual({
      provider: 'copilot',
      session: null,
      weekly: null,
      monthly: {
        usedPercent: 40,
        windowMinutes: 43_200,
        resetsAt: NEXT_MONTH_START,
        resetDescription: null
      },
      allowance: {
        unit: { kind: 'count', label: 'AI credits' },
        used: 400_000,
        limit: 1_000_000,
        resetsAt: NEXT_MONTH_START
      },
      updatedAt: FROZEN_NOW,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    })
  })

  it('defaults an error to usage-unavailable and carries an explicit failure kind', () => {
    const implicit = makeCopilotError('could not read the entitlement')
    const explicit = makeCopilotError('unreadable JSON', 'parse')

    expect(implicit.status).toBe('error')
    expect(implicit.error).toBe('could not read the entitlement')
    expect(implicit.usageMetadata).toEqual({ failureKind: 'usage-unavailable', source: 'web' })
    expect(explicit.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
    expect(implicit.allowance).toBeUndefined()
    expect(implicit.monthly).toBeUndefined()
  })
})
