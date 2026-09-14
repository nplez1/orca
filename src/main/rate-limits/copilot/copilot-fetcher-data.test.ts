import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCopilotSnapshot,
  buildCopilotTotals,
  COPILOT_MONTHLY_WINDOW_MINUTES,
  findCopilotAiCreditBudget,
  makeCopilotError,
  makeCopilotUnavailable,
  readNextMonthStartUtc,
  sumCopilotUsage,
  type CopilotBudget,
  type CopilotCreditTotals
} from './copilot-fetcher-data'

// A mid-month instant, so the next-month boundary is unambiguous.
const FROZEN_NOW = Date.parse('2026-07-04T12:00:00.000Z')
const NEXT_MONTH_START = Date.UTC(2026, 7, 1)

// GitHub returns fields beyond the ones the mapper reads; the fixture carries them.
type BudgetFixture = CopilotBudget & {
  id: string
  prevent_further_usage: boolean
  budget_alerting: { will_alert: boolean; alert_recipients: string[] }
}

function aiCreditBudget(amount: unknown): BudgetFixture {
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

function otherBudget(sku: string, amount: number): CopilotBudget {
  return { budget_type: 'ProductPricing', budget_product_skus: [sku], budget_amount: amount }
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

function totalsFor(budgetAmountDollars: number, items: Record<string, unknown>[]) {
  return buildCopilotTotals(budgetAmountDollars, sumCopilotUsage(items))
}

function totalsFromUsage(
  budgetAmountDollars: number,
  usage: Partial<CopilotCreditTotals>
): ReturnType<typeof buildCopilotTotals> {
  return buildCopilotTotals(budgetAmountDollars, {
    used: 0,
    limit: 0,
    usedDollars: 0,
    limitDollars: 0,
    pricePerUnit: null,
    ...usage
  })
}

describe('sumCopilotUsage', () => {
  it('sums credits from netQuantity and dollars from netAmount, keeping the units apart', () => {
    const summed = sumCopilotUsage([
      usageItem({ netQuantity: 250_000, netAmount: 2_500 }),
      usageItem({ netQuantity: 150_000, netAmount: 1_500 })
    ])

    expect(summed.used).toBe(400_000)
    expect(summed.usedDollars).toBe(4_000)
    expect(summed.pricePerUnit).toBe(0.01)
  })

  it('reads the numeric strings GitHub sometimes returns as numbers', () => {
    const summed = sumCopilotUsage([
      usageItem({ netQuantity: '250', netAmount: '2.50', pricePerUnit: '0.01' })
    ])

    expect(summed.used).toBe(250)
    expect(summed.usedDollars).toBe(2.5)
    expect(summed.pricePerUnit).toBe(0.01)
  })

  it('ignores quantities, amounts and prices that are not finite numbers', () => {
    const summed = sumCopilotUsage([
      usageItem({ netQuantity: 'abc', netAmount: {}, pricePerUnit: [] }),
      usageItem({ netQuantity: Number.POSITIVE_INFINITY, netAmount: null, pricePerUnit: 'free' }),
      usageItem({ netQuantity: '   ', netAmount: Number.NaN, pricePerUnit: Number.NaN })
    ])

    expect(summed.used).toBe(0)
    expect(summed.usedDollars).toBe(0)
    expect(summed.pricePerUnit).toBeNull()
  })

  it.each([
    ['zero', 0],
    ['negative', -0.01],
    ['a non-numeric string', 'free'],
    ['null', null]
  ])('reports no price when the report prices a credit at %s', (_label, price) => {
    expect(sumCopilotUsage([usageItem({ pricePerUnit: price })]).pricePerUnit).toBeNull()
  })

  it('keeps the first positive price when the report disagrees across items', () => {
    const summed = sumCopilotUsage([
      usageItem({ pricePerUnit: 0 }),
      usageItem({ pricePerUnit: 0.02 }),
      usageItem({ pricePerUnit: 0.05 })
    ])

    expect(summed.pricePerUnit).toBe(0.02)
  })

  it('sums an empty usage report to zero with no price', () => {
    expect(sumCopilotUsage([])).toEqual({
      used: 0,
      limit: 0,
      usedDollars: 0,
      limitDollars: 0,
      pricePerUnit: null
    })
  })
})

describe('findCopilotAiCreditBudget', () => {
  it('returns null when the enterprise reports no budgets at all', () => {
    expect(findCopilotAiCreditBudget([])).toBeNull()
  })

  it('returns null when budgets exist but none covers AI credits', () => {
    expect(
      findCopilotAiCreditBudget([otherBudget('actions', 1_000), otherBudget('packages', 2_000)])
    ).toBeNull()
  })

  it('picks the AI-credit budget out of the enterprise’s other product budgets', () => {
    const budgets = [
      otherBudget('actions', 1_000),
      otherBudget('packages', 2_000),
      aiCreditBudget(10_000)
    ]

    const found = findCopilotAiCreditBudget(budgets)

    expect(found).toBe(budgets[2])
    expect(found?.budget_amount).toBe(10_000)
  })

  it('finds the SKU in a plural list containing other products, despite case', () => {
    const budget: CopilotBudget = {
      budget_product_skus: ['actions', 'AI_Credits'],
      budget_amount: 4_000
    }

    expect(findCopilotAiCreditBudget([budget])).toBe(budget)
  })

  it('finds the SKU in the singular string form, despite surrounding whitespace', () => {
    const budget: CopilotBudget = { budget_product_sku: '  ai_credits  ', budget_amount: 4_000 }

    expect(findCopilotAiCreditBudget([budget])).toBe(budget)
  })

  it.each([
    ['numbers and nulls in the plural list', { budget_product_skus: [null, 5] }],
    ['a non-string singular SKU', { budget_product_sku: 7 }],
    ['a missing SKU field', {}],
    ['a string where the plural list belongs', { budget_product_skus: 'ai_credits' }]
  ])('treats %s as carrying no AI-credit SKU', (_label, skuFields) => {
    expect(findCopilotAiCreditBudget([{ ...skuFields, budget_amount: 100 }])).toBeNull()
  })

  it('does not match a SKU that merely contains the AI-credit token', () => {
    expect(findCopilotAiCreditBudget([otherBudget('ai_credits_extra', 100)])).toBeNull()
  })

  it('returns the first AI-credit budget when the enterprise holds more than one', () => {
    const first = aiCreditBudget(10_000)
    const second = aiCreditBudget(20_000)

    expect(findCopilotAiCreditBudget([first, second])).toBe(first)
  })
})

describe('buildCopilotTotals', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FROZEN_NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('converts a 10,000-dollar budget into one million AI credits at the reported 0.01 price', () => {
    const { allowance, window } = totalsFor(10_000, [
      usageItem({ netQuantity: 250_000, netAmount: 2_500 }),
      usageItem({ netQuantity: 150_000, netAmount: 1_500 })
    ])

    expect(allowance).toEqual({
      unit: { kind: 'count', label: 'AI credits' },
      used: 400_000,
      limit: 1_000_000,
      resetsAt: NEXT_MONTH_START
    })
    expect(window.usedPercent).toBe(40)
    expect(window.windowMinutes).toBe(COPILOT_MONTHLY_WINDOW_MINUTES)
    expect(window.windowMinutes).toBe(43_200)
    expect(window.resetDescription).toBeNull()
  })

  it('reports credits consumed, not the dollar amount the same usage is worth', () => {
    const { allowance } = totalsFor(10_000, [
      usageItem({ netQuantity: 250_000, netAmount: 2_500 }),
      usageItem({ netQuantity: 150_000, netAmount: 1_500 })
    ])

    expect(allowance.used).toBe(400_000)
    expect(allowance.used).not.toBe(4_000)
    expect(allowance.limit).toBe(1_000_000)
  })

  it('falls back to dollars when the usage report prices no AI credit', () => {
    const { allowance, window } = totalsFor(8_000, [
      usageItem({
        unitType: 'dollars',
        netQuantity: 300,
        netAmount: 42.5,
        pricePerUnit: undefined
      }),
      usageItem({ unitType: 'dollars', netQuantity: 100, netAmount: 7.5, pricePerUnit: undefined })
    ])

    expect(allowance).toEqual({
      unit: { kind: 'money', currencyCode: 'USD' },
      used: 50,
      limit: 8_000,
      resetsAt: NEXT_MONTH_START
    })
    expect(window.usedPercent).toBe(0.625)
  })

  it.each([
    ['zero', 0],
    ['a non-numeric string', 'free'],
    ['a negative price', -0.01]
  ])('falls back to dollars when the price per unit is %s', (_label, pricePerUnit) => {
    const { allowance } = totalsFor(500, [
      usageItem({ netQuantity: 100, netAmount: 25, pricePerUnit })
    ])

    expect(allowance.unit).toEqual({ kind: 'money', currencyCode: 'USD' })
    expect(allowance.used).toBe(25)
    expect(allowance.limit).toBe(500)
  })

  it('clamps a runaway percentage to 100 and a negative one to 0', () => {
    const over = totalsFromUsage(10_000, { used: 2_000_000, pricePerUnit: 0.01 })
    const under = totalsFromUsage(100, { used: -5, pricePerUnit: 0.01 })

    expect(over.allowance.limit).toBe(1_000_000)
    expect(over.window.usedPercent).toBe(100)
    expect(under.allowance.limit).toBe(10_000)
    expect(under.window.usedPercent).toBe(0)
  })

  it('reports zero percent rather than dividing by a zero ceiling', () => {
    const { allowance, window } = totalsFromUsage(0, { used: 10, pricePerUnit: 0.01 })

    expect(allowance.limit).toBe(0)
    expect(window.usedPercent).toBe(0)
  })

  it('stamps the next UTC month start on both the allowance and the window', () => {
    const { allowance, window, resetsAt } = totalsFor(10_000, [
      usageItem({ netQuantity: 100, netAmount: 1 })
    ])

    expect(resetsAt).toBe(NEXT_MONTH_START)
    expect(allowance.resetsAt).toBe(NEXT_MONTH_START)
    expect(window.resetsAt).toBe(NEXT_MONTH_START)
  })
})

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

describe('copilot snapshot factories', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FROZEN_NOW))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks a successful read as ok with the monthly window and the allowance', () => {
    const snapshot = buildCopilotSnapshot(
      totalsFor(10_000, [usageItem({ netQuantity: 400_000, netAmount: 4_000 })])
    )

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

  it('reports missing credentials as unavailable rather than as an error', () => {
    expect(makeCopilotUnavailable('sign in or add a token')).toEqual({
      provider: 'copilot',
      session: null,
      weekly: null,
      updatedAt: FROZEN_NOW,
      error: 'sign in or add a token',
      status: 'unavailable',
      usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
    })
  })

  it('defaults an error to usage-unavailable and carries an explicit failure kind', () => {
    const implicit = makeCopilotError('could not read the budget')
    const explicit = makeCopilotError('unreadable JSON', 'parse')

    expect(implicit.status).toBe('error')
    expect(implicit.error).toBe('could not read the budget')
    expect(implicit.usageMetadata).toEqual({ failureKind: 'usage-unavailable', source: 'web' })
    expect(explicit.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
    expect(implicit.allowance).toBeUndefined()
    expect(implicit.monthly).toBeUndefined()
  })
})
