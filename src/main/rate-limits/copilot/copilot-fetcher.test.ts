import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageRateLimitFailureKind } from '../../../shared/rate-limit-types'

const netFetchMock = vi.hoisted(() => vi.fn())

// Why: net.fetch is the whole transport for these two endpoints, so mocking that one
// surface keeps the suite off the real GitHub billing API.
vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

import { fetchCopilotRateLimits } from './copilot-fetcher'

const API_BASE = 'https://api.github.com'
const ENTERPRISE = 'acme-corp'
const TOKEN = 'ghp_enterprise_billing_token'
// A mid-month instant, so the next-month boundary is unambiguous.
const FROZEN_NOW = Date.parse('2026-07-04T12:00:00.000Z')
const NEXT_MONTH_START = Date.UTC(2026, 7, 1)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } })
}

function aiCreditBudget(amount: unknown): Record<string, unknown> {
  return {
    id: 'budget-ai-credits',
    budget_type: 'BundlePricing',
    budget_product_skus: ['ai_credits'],
    budget_scope: 'enterprise',
    budget_amount: amount,
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['billing-manager'] }
  }
}

function usageItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product: 'Copilot',
    sku: 'Copilot AI Credits',
    model: 'GPT-5',
    unitType: 'credits',
    pricePerUnit: 0.01,
    grossQuantity: 0,
    grossAmount: 0,
    discountQuantity: 0,
    discountAmount: 0,
    netQuantity: 0,
    netAmount: 0,
    ...overrides
  }
}

function budgetsResponse(budgets: unknown[], hasNextPage = false): Response {
  return jsonResponse({ budgets, has_next_page: hasNextPage, total_count: budgets.length })
}

function usageResponse(items: unknown[]): Response {
  return jsonResponse({
    timePeriod: { year: 2026, month: 7 },
    enterprise: 'GitHub',
    usageItems: items
  })
}

function primeOk(budgets: unknown[], items: unknown[]): void {
  netFetchMock
    .mockResolvedValueOnce(budgetsResponse(budgets))
    .mockResolvedValueOnce(usageResponse(items))
}

function callUrl(index: number): URL {
  return new URL(String(netFetchMock.mock.calls[index]?.[0]))
}

function requestOptions(): { token: string; enterpriseSlug: string } {
  return { token: TOKEN, enterpriseSlug: ENTERPRISE }
}

describe('fetchCopilotRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FROZEN_NOW))
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('converts the dollar budget into the AI credits the usage report prices', async () => {
    primeOk(
      [aiCreditBudget(10_000)],
      [
        usageItem({ netQuantity: 250_000, netAmount: 2_500 }),
        usageItem({ netQuantity: 150_000, netAmount: 1_500 })
      ]
    )

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result).toEqual({
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
    // 10,000 dollars at the documented 0.01 price lands on exactly one million credits.
    expect(result.allowance?.limit).toBe(1_000_000)
    expect(result.allowance?.unit).toEqual({ kind: 'count', label: 'AI credits' })
    expect(result.allowance?.used).toBe(400_000)
    expect(result.monthly?.usedPercent).toBe((400_000 / 1_000_000) * 100)
    expect(result.monthly?.windowMinutes).toBe(43_200)
  })

  it('reports credits consumed, not the dollar amount the same usage is worth', async () => {
    primeOk(
      [aiCreditBudget(10_000)],
      [
        usageItem({ netQuantity: 250_000, netAmount: 2_500 }),
        usageItem({ netQuantity: 150_000, netAmount: 1_500 })
      ]
    )

    const result = await fetchCopilotRateLimits(requestOptions())

    const summedDollars = 2_500 + 1_500
    const summedCredits = 250_000 + 150_000
    expect(summedDollars).toBe(4_000)
    expect(result.allowance?.used).toBe(summedCredits)
    expect(result.allowance?.used).not.toBe(summedDollars)
    expect(result.allowance?.unit).toEqual({ kind: 'count', label: 'AI credits' })
  })

  it('falls back to dollars when the usage report reports no credit price', async () => {
    primeOk(
      [aiCreditBudget(8_000)],
      [
        usageItem({
          unitType: 'dollars',
          netQuantity: 300,
          netAmount: 42.5,
          pricePerUnit: undefined
        }),
        usageItem({
          unitType: 'dollars',
          netQuantity: 100,
          netAmount: 7.5,
          pricePerUnit: undefined
        })
      ]
    )

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('ok')
    expect(result.allowance).toEqual({
      unit: { kind: 'money', currencyCode: 'USD' },
      used: 50,
      limit: 8_000,
      resetsAt: NEXT_MONTH_START
    })
    expect(result.monthly?.usedPercent).toBe(0.625)
    expect(Number.isFinite(result.allowance?.limit)).toBe(true)
    expect(Number.isFinite(result.allowance?.used)).toBe(true)
    expect(Number.isFinite(result.monthly?.usedPercent)).toBe(true)
  })

  it('picks the AI-credit budget out of the enterprise’s other product budgets', async () => {
    primeOk(
      [
        { budget_type: 'ProductPricing', budget_product_skus: ['actions'], budget_amount: 1_000 },
        { budget_type: 'ProductPricing', budget_product_skus: ['packages'], budget_amount: 2_000 },
        aiCreditBudget(10_000)
      ],
      [usageItem({ netQuantity: 100, netAmount: 1 })]
    )

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('ok')
    // Only the AI-credit budget's amount produces this ceiling.
    expect(result.allowance?.limit).toBe(1_000_000)
    expect(result.allowance?.used).toBe(100)
  })

  it.each([
    ['plural array', { budget_product_skus: ['actions', 'AI_Credits'] }],
    ['singular string', { budget_product_sku: '  ai_credits  ' }]
  ])(
    'recognises the %s budget SKU shape despite case and whitespace',
    async (_shape, skuFields) => {
      primeOk(
        [
          { budget_amount: 4_000, ...skuFields },
          { budget_product_skus: ['actions'], budget_amount: 99 }
        ],
        [usageItem({ netQuantity: 10, netAmount: 0.1 })]
      )

      const result = await fetchCopilotRateLimits(requestOptions())

      expect(result.status).toBe('ok')
      expect(result.allowance?.limit).toBe(400_000)
      expect(result.allowance?.used).toBe(10)
    }
  )

  it('follows has_next_page to find the AI-credit budget', async () => {
    netFetchMock
      .mockResolvedValueOnce(
        budgetsResponse([{ budget_product_skus: ['actions'], budget_amount: 1_000 }], true)
      )
      .mockResolvedValueOnce(budgetsResponse([aiCreditBudget(10_000)]))
      .mockResolvedValueOnce(usageResponse([usageItem({ netQuantity: 100, netAmount: 1 })]))

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('ok')
    expect(result.allowance?.limit).toBe(1_000_000)
    expect(callUrl(0).searchParams.get('page')).toBe('1')
    expect(callUrl(1).searchParams.get('page')).toBe('2')
    expect(callUrl(2).pathname).toContain('/ai_credit/usage')
  })

  it('errors with a message naming the enterprise when no AI-credit budget exists', async () => {
    netFetchMock.mockResolvedValueOnce(
      budgetsResponse([{ budget_product_skus: ['actions'], budget_amount: 1_000 }])
    )

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('error')
    expect(result.status).not.toBe('unavailable')
    expect(result.error).toContain(ENTERPRISE)
    expect(result.error).toMatch(/no ai-credit budget/i)
    expect(result.usageMetadata).toEqual({ failureKind: 'usage-unavailable', source: 'web' })
    expect(result.allowance).toBeUndefined()
    // The usage endpoint is pointless once the ceiling is known to be missing.
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it('reads the budget then the current month’s usage with the documented request shape', async () => {
    primeOk([aiCreditBudget(10_000)], [usageItem({ netQuantity: 1, netAmount: 0.01 })])

    await fetchCopilotRateLimits(requestOptions())

    expect(netFetchMock).toHaveBeenCalledTimes(2)
    const budgetsUrl = callUrl(0)
    expect(`${budgetsUrl.origin}${budgetsUrl.pathname}`).toBe(
      `${API_BASE}/enterprises/${ENTERPRISE}/settings/billing/budgets`
    )
    expect(budgetsUrl.searchParams.get('per_page')).toBe('100')

    const usageUrl = callUrl(1)
    expect(`${usageUrl.origin}${usageUrl.pathname}`).toBe(
      `${API_BASE}/enterprises/${ENTERPRISE}/settings/billing/ai_credit/usage`
    )
    expect(usageUrl.searchParams.get('year')).toBe('2026')
    expect(usageUrl.searchParams.get('month')).toBe('7')

    expect(netFetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${TOKEN}`,
        'X-GitHub-Api-Version': '2026-03-10'
      }
    })
  })

  const HTTP_STATUS_CASES: [number, UsageRateLimitFailureKind, RegExp][] = [
    [401, 'stale-token', /rejected the token/i],
    [403, 'missing-scope', /Enterprise billing/],
    [404, 'usage-unavailable', /check the enterprise slug/i],
    [500, 'server', /server error/i]
  ]

  it.each(HTTP_STATUS_CASES)(
    'maps HTTP %i on the budget endpoint to failureKind %s',
    async (status, failureKind, messagePattern) => {
      netFetchMock.mockResolvedValueOnce(jsonResponse({ message: 'nope' }, status))

      const result = await fetchCopilotRateLimits(requestOptions())

      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe(failureKind)
      expect(result.error).toMatch(messagePattern)
    }
  )

  it.each(HTTP_STATUS_CASES)(
    'maps HTTP %i on the usage endpoint to failureKind %s',
    async (status, failureKind) => {
      netFetchMock
        .mockResolvedValueOnce(budgetsResponse([aiCreditBudget(10_000)]))
        .mockResolvedValueOnce(jsonResponse({ message: 'nope' }, status))

      const result = await fetchCopilotRateLimits(requestOptions())

      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe(failureKind)
    }
  )

  it('falls back to usage-unavailable for an unmapped HTTP status', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ message: 'bad request' }, 400))

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toContain('400')
  })

  it('classifies a transport throw as a network error', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('socket hang up'))

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'network', source: 'web' })
    expect(result.error).toContain('socket hang up')
    expect(result.error).toContain('Could not reach GitHub')
  })

  it('classifies a malformed JSON body as a parse error without throwing', async () => {
    netFetchMock.mockResolvedValueOnce(htmlResponse('<html><body>gateway error</body></html>'))

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
    expect(result.error).toMatch(/unreadable json/i)
  })

  it.each([
    ['a blank token', { token: '   ', enterpriseSlug: ENTERPRISE }],
    ['a blank enterprise slug', { token: TOKEN, enterpriseSlug: '  ' }]
  ])('returns unavailable without any request when the account has %s', async (_label, options) => {
    const result = await fetchCopilotRateLimits(options)

    expect(result.status).toBe('unavailable')
    expect(result.provider).toBe('copilot')
    expect(result.allowance).toBeUndefined()
    expect(result.monthly).toBeUndefined()
    expect(result.error).toMatch(/not configured/i)
    expect(result.usageMetadata).toEqual({ failureKind: 'missing-credentials', source: 'web' })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('resets at the first instant of the next UTC month on both windows', async () => {
    primeOk([aiCreditBudget(10_000)], [usageItem({ netQuantity: 100, netAmount: 1 })])

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.monthly?.resetsAt).toBe(Date.UTC(2026, 7, 1))
    expect(result.allowance?.resetsAt).toBe(Date.UTC(2026, 7, 1))
    expect(result.monthly?.resetsAt).toBe(result.allowance?.resetsAt)
  })

  it('rolls the reset over the year boundary in UTC', async () => {
    vi.setSystemTime(new Date(Date.parse('2026-12-31T23:30:00.000Z')))
    netFetchMock
      .mockResolvedValueOnce(budgetsResponse([aiCreditBudget(10_000)]))
      .mockResolvedValueOnce(
        jsonResponse({
          timePeriod: { year: 2026 },
          usageItems: [usageItem({ netQuantity: 1, netAmount: 0.01 })]
        })
      )

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.allowance?.resetsAt).toBe(Date.UTC(2027, 0, 1))
    expect(result.monthly?.resetsAt).toBe(Date.UTC(2027, 0, 1))
    // The usage query follows the frozen clock, not the reset boundary.
    expect(callUrl(1).searchParams.get('month')).toBe('12')
    expect(callUrl(1).searchParams.get('year')).toBe('2026')
  })

  it.each([
    ['zero', 0],
    ['a non-numeric string', 'not-a-number'],
    ['null', null],
    ['an empty string', '']
  ])('errors cleanly rather than dividing by %s budget_amount', async (_label, amount) => {
    netFetchMock.mockResolvedValueOnce(budgetsResponse([aiCreditBudget(amount)]))

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
    expect(result.error).toMatch(/no usable amount/i)
    expect(result.allowance).toBeUndefined()
    expect(result.monthly).toBeUndefined()
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['zero', 0],
    ['a non-numeric string', 'free']
  ])('falls back to dollars when pricePerUnit is %s', async (_label, price) => {
    primeOk(
      [aiCreditBudget(500)],
      [usageItem({ netQuantity: 100, netAmount: 25, pricePerUnit: price })]
    )

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('ok')
    expect(result.allowance).toEqual({
      unit: { kind: 'money', currencyCode: 'USD' },
      used: 25,
      limit: 500,
      resetsAt: NEXT_MONTH_START
    })
    expect(result.monthly?.usedPercent).toBe(5)
    expect(Number.isFinite(result.allowance?.limit)).toBe(true)
    expect(Number.isFinite(result.monthly?.usedPercent)).toBe(true)
  })

  type GarbageCase = {
    label: string
    budgetsBody: unknown
    usagePayload?: unknown
    expectedStatus: 'ok' | 'error'
    expectedFailureKind?: UsageRateLimitFailureKind
    expectedLimit?: number
    expectedUsed?: number
  }

  const GARBAGE_CASES: GarbageCase[] = [
    {
      label: 'a null budget body',
      budgetsBody: null,
      expectedStatus: 'error',
      expectedFailureKind: 'usage-unavailable'
    },
    {
      label: 'an array where the budget object belongs',
      budgetsBody: [],
      expectedStatus: 'error',
      expectedFailureKind: 'usage-unavailable'
    },
    {
      label: 'a string where the budget object belongs',
      budgetsBody: 'not-an-object',
      expectedStatus: 'error',
      expectedFailureKind: 'usage-unavailable'
    },
    {
      label: 'a null budgets field',
      budgetsBody: { budgets: null },
      expectedStatus: 'error',
      expectedFailureKind: 'usage-unavailable'
    },
    {
      label: 'a string budgets field',
      budgetsBody: { budgets: 'nope' },
      expectedStatus: 'error',
      expectedFailureKind: 'usage-unavailable'
    },
    {
      label: 'nulls and scalars inside budgets',
      budgetsBody: { budgets: [null, 7, 'x', []] },
      expectedStatus: 'error',
      expectedFailureKind: 'usage-unavailable'
    },
    {
      label: 'non-string entries inside budget_product_skus',
      budgetsBody: { budgets: [{ budget_product_skus: [null, 5], budget_amount: 100 }] },
      expectedStatus: 'error',
      expectedFailureKind: 'usage-unavailable'
    },
    {
      label: 'an object where budget_amount belongs',
      budgetsBody: { budgets: [{ budget_product_skus: ['ai_credits'], budget_amount: {} }] },
      expectedStatus: 'error',
      expectedFailureKind: 'parse'
    },
    {
      label: 'a null usage body',
      budgetsBody: { budgets: [aiCreditBudget(5_000)], has_next_page: false },
      usagePayload: null,
      expectedStatus: 'ok',
      expectedLimit: 5_000,
      expectedUsed: 0
    },
    {
      label: 'an array where the usage object belongs',
      budgetsBody: { budgets: [aiCreditBudget(5_000)], has_next_page: false },
      usagePayload: [],
      expectedStatus: 'ok',
      expectedLimit: 5_000,
      expectedUsed: 0
    },
    {
      label: 'a string usageItems field',
      budgetsBody: { budgets: [aiCreditBudget(5_000)], has_next_page: false },
      usagePayload: { usageItems: 'nope' },
      expectedStatus: 'ok',
      expectedLimit: 5_000,
      expectedUsed: 0
    },
    {
      label: 'nulls and scalars inside usageItems',
      budgetsBody: { budgets: [aiCreditBudget(5_000)], has_next_page: false },
      usagePayload: { usageItems: [null, 7, 'x', []] },
      expectedStatus: 'ok',
      expectedLimit: 5_000,
      expectedUsed: 0
    },
    {
      label: 'non-numeric quantities and prices',
      budgetsBody: { budgets: [aiCreditBudget(5_000)], has_next_page: false },
      usagePayload: { usageItems: [{ netQuantity: 'abc', netAmount: {}, pricePerUnit: [] }] },
      expectedStatus: 'ok',
      expectedLimit: 5_000,
      expectedUsed: 0
    },
    {
      label: 'numeric strings where numbers are documented',
      budgetsBody: { budgets: [aiCreditBudget(5_000)], has_next_page: false },
      usagePayload: {
        usageItems: [{ netQuantity: '250', netAmount: '2.50', pricePerUnit: '0.01' }]
      },
      expectedStatus: 'ok',
      expectedLimit: 500_000,
      expectedUsed: 250
    }
  ]

  it.each(GARBAGE_CASES)(
    'never throws and still returns a snapshot for $label',
    async (testCase) => {
      netFetchMock.mockResolvedValueOnce(jsonResponse(testCase.budgetsBody))
      if (testCase.usagePayload !== undefined) {
        netFetchMock.mockResolvedValueOnce(jsonResponse(testCase.usagePayload))
      }

      const result = await fetchCopilotRateLimits(requestOptions())

      expect(result.provider).toBe('copilot')
      expect(result.status).toBe(testCase.expectedStatus)
      expect(result.updatedAt).toBe(FROZEN_NOW)
      if (testCase.expectedFailureKind !== undefined) {
        expect(result.usageMetadata?.failureKind).toBe(testCase.expectedFailureKind)
      }
      if (testCase.expectedLimit !== undefined) {
        expect(result.allowance?.limit).toBe(testCase.expectedLimit)
        expect(result.allowance?.used).toBe(testCase.expectedUsed)
      }
    }
  )
})
