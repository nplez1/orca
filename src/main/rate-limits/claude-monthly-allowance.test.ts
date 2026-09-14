import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock, resolveProxyMock, setProxyMock, appGetPathMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  resolveProxyMock: vi.fn(),
  setProxyMock: vi.fn(),
  appGetPathMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  net: { fetch: netFetchMock },
  session: { defaultSession: { resolveProxy: resolveProxyMock, setProxy: setProxyMock } }
}))

import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'

/** Integer count of 10^-exponent units, e.g. 640000 at exponent 2 is 6400.00. */
function money(amountMinor: number, exponent: number | undefined, currency?: string) {
  return {
    amount_minor: amountMinor,
    ...(exponent === undefined ? {} : { exponent }),
    ...(currency === undefined ? {} : { currency })
  }
}

/**
 * Enterprise/usage-billed payload: both subscription windows null, the monthly cap in
 * `spend` and a duplicate of it as credits in `extra_usage`. Key names and the
 * number-vs-string types mirror the real provider response; the figures are invented.
 */
function enterpriseUsagePayload(overrides: Record<string, unknown> = {}) {
  return {
    five_hour: null,
    seven_day: null,
    limits: [],
    extra_usage: {
      currency: 'USD',
      decimal_places: 2,
      is_enabled: true,
      monthly_limit: 640_000,
      used_credits: 15_360,
      utilization: 2.87
    },
    spend: {
      enabled: true,
      percent: 3,
      severity: 'normal',
      limit: money(640_000, 2, 'USD'),
      used: money(15_360, 2, 'USD')
    },
    ...overrides
  }
}

function fetchUsage(payload: unknown) {
  netFetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
  return fetchClaudeOAuthUsage('oauth-token')
}

describe('Claude monthly allowance for windowless plans', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appGetPathMock.mockReturnValue('/tmp/orca-claude-monthly-test')
    resolveProxyMock.mockResolvedValue('DIRECT')
    setProxyMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports the provider percent and the minor-unit allowance when both windows are null', async () => {
    const result = await fetchUsage(enterpriseUsagePayload())

    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.monthly).toEqual({
      usedPercent: 3,
      windowMinutes: 43_200,
      resetsAt: null,
      resetDescription: null
    })
    expect(result.allowance).toEqual({
      unit: { kind: 'money', currencyCode: 'USD' },
      used: 153.6,
      limit: 6400,
      resetsAt: null
    })
    // 640000 minor units at exponent 2 is exactly 6400, not an approximation.
    expect(result.allowance?.limit).toBe(640_000 / 100)
    expect(result.allowance?.used).toBe(15_360 / 100)
    expect(result.updatedAt).toBeGreaterThan(0)
    expect(result.error).toBeNull()
    expect(result.status).toBe('ok')
  })

  it('converts minor units with the exponent the payload declares', async () => {
    const result = await fetchUsage(
      enterpriseUsagePayload({
        spend: {
          enabled: true,
          percent: 7,
          limit: money(1_250_000, 3, 'USD'),
          used: money(27_500, 3, 'USD')
        }
      })
    )

    expect(result.allowance?.limit).toBe(1250)
    expect(result.allowance?.used).toBe(27.5)
  })

  it('treats an exponent of 0 as whole-unit money rather than a missing exponent', async () => {
    const result = await fetchUsage(
      enterpriseUsagePayload({
        spend: {
          enabled: true,
          percent: 9,
          limit: money(640_000, 0, 'USD'),
          used: money(15_360, 0, 'USD')
        }
      })
    )

    expect(result.allowance).toEqual({
      unit: { kind: 'money', currencyCode: 'USD' },
      used: 15_360,
      limit: 640_000,
      resetsAt: null
    })
  })

  it('uses spend.percent rather than extra_usage.utilization when both are present', async () => {
    const result = await fetchUsage(enterpriseUsagePayload())

    // The payload reports a rounded 3 in spend and 2.87 in extra_usage.
    expect(result.monthly?.usedPercent).toBe(3)
    expect(result.monthly?.usedPercent).not.toBe(2.87)
  })

  it('keeps a subscription account on its 5h/7d bars with no monthly bar', async () => {
    const result = await fetchUsage(
      enterpriseUsagePayload({
        five_hour: { utilization: 41, resets_at: 1_800_000_000 },
        seven_day: { utilization: 62, resets_at: 1_800_100_000 }
      })
    )

    expect(result.session?.usedPercent).toBe(41)
    expect(result.weekly?.usedPercent).toBe(62)
    expect(Object.hasOwn(result, 'monthly')).toBe(false)
    expect(Object.hasOwn(result, 'allowance')).toBe(false)
  })

  it('omits the monthly bar when only the weekly window is present', async () => {
    const result = await fetchUsage(enterpriseUsagePayload({ seven_day: { utilization: 30 } }))

    expect(result.session).toBeNull()
    expect(result.weekly?.usedPercent).toBe(30)
    expect(Object.hasOwn(result, 'monthly')).toBe(false)
    expect(Object.hasOwn(result, 'allowance')).toBe(false)
  })

  it('falls back to extra_usage when spend is absent', async () => {
    const result = await fetchUsage({
      five_hour: null,
      seven_day: null,
      limits: [],
      extra_usage: {
        currency: 'USD',
        decimal_places: 2,
        is_enabled: true,
        monthly_limit: 450_000,
        used_credits: 9000,
        utilization: 2
      }
    })

    expect(result.monthly?.usedPercent).toBe(2)
    expect(result.monthly?.windowMinutes).toBe(43_200)
    expect(result.monthly?.resetsAt).toBeNull()
    expect(result.allowance).toEqual({
      unit: { kind: 'money', currencyCode: 'USD' },
      used: 90,
      limit: 4500,
      resetsAt: null
    })
  })

  it('falls back to extra_usage.utilization when spend carries no percent', async () => {
    const result = await fetchUsage(
      enterpriseUsagePayload({
        spend: {
          enabled: true,
          limit: money(640_000, 2, 'USD'),
          used: money(15_360, 2, 'USD')
        }
      })
    )

    expect(result.monthly?.usedPercent).toBe(2.87)
    expect(result.allowance?.used).toBe(153.6)
    expect(result.allowance?.limit).toBe(6400)
  })

  it.each([{ currency: 'EUR' }, { currency: 'gbp' }])(
    'passes the $currency currency through verbatim',
    async ({ currency }) => {
      const result = await fetchUsage(
        enterpriseUsagePayload({
          spend: {
            enabled: true,
            percent: 3,
            limit: money(640_000, 2, currency),
            used: money(15_360, 2, currency)
          }
        })
      )

      expect(result.allowance?.unit).toEqual({ kind: 'money', currencyCode: currency })
    }
  )

  it('reads the currency from extra_usage when spend omits it', async () => {
    const result = await fetchUsage(
      enterpriseUsagePayload({
        spend: {
          enabled: true,
          percent: 3,
          limit: money(640_000, 2),
          used: money(15_360, 2)
        },
        extra_usage: {
          currency: 'CAD',
          decimal_places: 2,
          monthly_limit: 640_000,
          used_credits: 15_360,
          utilization: 2.87
        }
      })
    )

    expect(result.allowance?.unit).toEqual({ kind: 'money', currencyCode: 'CAD' })
  })

  it.each([
    {
      name: 'no spend objects at all',
      payload: { five_hour: null, seven_day: null, limits: [] }
    },
    {
      name: 'null spend objects',
      payload: { five_hour: null, seven_day: null, limits: [], spend: null, extra_usage: null }
    },
    {
      name: 'non-object spend objects',
      payload: {
        five_hour: null,
        seven_day: null,
        limits: [],
        spend: [],
        extra_usage: 'unavailable'
      }
    },
    {
      name: 'garbage percent and amount types',
      payload: {
        five_hour: null,
        seven_day: null,
        limits: [],
        spend: { percent: 'high', limit: { amount_minor: 'many', exponent: 'two' }, used: null },
        extra_usage: {
          currency: 'USD',
          decimal_places: 'lots',
          monthly_limit: 'plenty',
          used_credits: {},
          utilization: '3'
        }
      }
    },
    {
      name: 'object-valued percent fields',
      payload: {
        five_hour: null,
        seven_day: null,
        limits: [],
        spend: { percent: {}, limit: {}, used: [] },
        extra_usage: { utilization: null }
      }
    }
  ])('produces no monthly bar and no allowance for $name', async ({ payload }) => {
    const result = await fetchUsage(payload)

    expect(result.status).toBe('ok')
    expect(Object.hasOwn(result, 'monthly')).toBe(false)
    expect(Object.hasOwn(result, 'allowance')).toBe(false)
  })

  it.each([
    { name: 'a missing exponent', exponent: undefined, percent: 5 },
    { name: 'a negative exponent', exponent: -2, percent: 4 },
    { name: 'a fractional exponent', exponent: 2.5, percent: 6 }
  ])('keeps the monthly bar but drops the allowance for $name', async ({ exponent, percent }) => {
    const result = await fetchUsage({
      five_hour: null,
      seven_day: null,
      limits: [],
      extra_usage: {
        currency: 'USD',
        monthly_limit: 640_000,
        used_credits: 15_360,
        utilization: 2.87
      },
      spend: {
        enabled: true,
        percent,
        limit: money(640_000, exponent, 'USD'),
        used: money(15_360, exponent, 'USD')
      }
    })

    expect(result.status).toBe('ok')
    expect(result.allowance).toBeUndefined()
    expect(result.monthly?.windowMinutes).toBe(43_200)
    expect(Number.isFinite(result.monthly?.usedPercent ?? Number.NaN)).toBe(true)
  })

  it('never reports NaN figures for unparsable amounts', async () => {
    const result = await fetchUsage({
      five_hour: null,
      seven_day: null,
      limits: [],
      extra_usage: { currency: 'USD', utilization: 1.5 },
      spend: {
        enabled: true,
        percent: 1.5,
        limit: { amount_minor: Number.POSITIVE_INFINITY, exponent: 2 },
        used: { amount_minor: 15_360, exponent: 2 }
      }
    })

    // JSON.stringify turns Infinity into null, which the parser must reject outright.
    expect(result.allowance).toBeUndefined()
    expect(result.monthly?.usedPercent).toBe(1.5)
  })
})
