import type { ProviderAllowance } from '../../../shared/provider-allowance'
import type { ProviderRateLimits, RateLimitWindow } from '../../../shared/rate-limit-types'

/**
 * Shapes for GitHub's billing API. Copilot reports a monthly AI-credit budget rather
 * than a quota window, so the numbers arrive from two endpoints: the budget carries
 * the ceiling, the usage report carries what has been consumed.
 *
 * Documented at:
 *   GET /enterprises/{enterprise}/settings/billing/budgets
 *   GET /enterprises/{enterprise}/settings/billing/ai_credit/usage
 * Both require a token with the "Enterprise billing" read permission; the `gh` CLI
 * token Orca otherwise uses has repo/read:org/project and cannot read them.
 */
export type CopilotBudget = {
  budget_type?: unknown
  budget_product_sku?: unknown
  budget_product_skus?: unknown
  budget_scope?: unknown
  budget_amount?: unknown
}

/** The units the budget denotes. Usage is reported in credits, the ceiling in dollars. */
export type CopilotCreditTotals = {
  used: number
  limit: number
  /** Dollars, used as the fallback unit when no credit price is reported. */
  usedDollars: number
  limitDollars: number
  pricePerUnit: number | null
}

// Why: 30 days, matching the window length the other monthly providers report.
export const COPILOT_MONTHLY_WINDOW_MINUTES = 43_200

export function makeCopilotUnavailable(error: string): ProviderRateLimits {
  return {
    provider: 'copilot',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
  }
}

export function makeCopilotError(
  error: string,
  failureKind: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind'] = 'usage-unavailable'
): ProviderRateLimits {
  return {
    provider: 'copilot',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { failureKind, source: 'web' }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  // Why: GitHub returns some billing integers as strings.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readBudgetSkus(budget: CopilotBudget): string[] {
  const skus: string[] = []
  // The list endpoint returns `budget_product_skus`; a single budget returns the
  // singular `budget_product_sku`.
  if (typeof budget.budget_product_sku === 'string') {
    skus.push(budget.budget_product_sku)
  }
  if (Array.isArray(budget.budget_product_skus)) {
    for (const sku of budget.budget_product_skus) {
      if (typeof sku === 'string') {
        skus.push(sku)
      }
    }
  }
  return skus.map((sku) => sku.trim().toLowerCase())
}

/**
 * The budget that covers Copilot AI credits. `BundlePricing` with the `ai_credits` SKU
 * is how GitHub documents an AI-credit budget; an enterprise also holds budgets for
 * unrelated products (actions, packages), so the SKU is what identifies ours.
 */
export function findCopilotAiCreditBudget(budgets: readonly CopilotBudget[]): CopilotBudget | null {
  for (const budget of budgets) {
    if (readBudgetSkus(budget).includes('ai_credits')) {
      return budget
    }
  }
  return null
}

/** Sums reported usage into credits and dollars, plus the credit price when given. */
export function sumCopilotUsage(items: readonly Record<string, unknown>[]): CopilotCreditTotals {
  let used = 0
  let usedDollars = 0
  let pricePerUnit: number | null = null
  for (const item of items) {
    const quantity = readFiniteNumber(item.netQuantity)
    if (quantity !== null) {
      used += quantity
    }
    const amount = readFiniteNumber(item.netAmount)
    if (amount !== null) {
      usedDollars += amount
    }
    const price = readFiniteNumber(item.pricePerUnit)
    if (price !== null && price > 0) {
      pricePerUnit = pricePerUnit ?? price
    }
  }
  return { used, limit: 0, usedDollars, limitDollars: 0, pricePerUnit }
}

/**
 * Converts the dollar budget into the unit the readout shows.
 *
 * Why credits lead: the budget is denominated in dollars while usage is reported in
 * AI credits, and the usage payload carries the price that relates them. Showing the
 * figure the user recognises therefore needs that one division. If no price is
 * reported the readout falls back to dollars rather than inventing a credit ceiling.
 */
export function buildCopilotTotals(
  budgetAmountDollars: number,
  usage: CopilotCreditTotals
): { allowance: ProviderAllowance; window: RateLimitWindow; resetsAt: number } {
  const resetsAt = readNextMonthStartUtc()
  const pricePerUnit = usage.pricePerUnit
  const limitCredits = pricePerUnit !== null ? budgetAmountDollars / pricePerUnit : null

  const unit =
    limitCredits !== null
      ? ({ kind: 'count', label: 'AI credits' } as const)
      : ({ kind: 'money', currencyCode: 'USD' } as const)
  const used = limitCredits !== null ? usage.used : usage.usedDollars
  const limit = limitCredits ?? budgetAmountDollars

  return {
    allowance: { unit, used, limit, resetsAt },
    window: {
      usedPercent: limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0,
      windowMinutes: COPILOT_MONTHLY_WINDOW_MINUTES,
      resetsAt,
      resetDescription: null
    },
    resetsAt
  }
}

/**
 * Why inferable here, unlike Claude's spend cap: GitHub documents these budgets as
 * monthly and the usage report is partitioned by calendar year/month, so the period
 * the displayed figure covers ends at the next month boundary.
 */
export function readNextMonthStartUtc(now: number = Date.now()): number {
  const current = new Date(now)
  return Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1)
}

export function buildCopilotSnapshot(totals: {
  allowance: ProviderAllowance
  window: RateLimitWindow
}): ProviderRateLimits {
  return {
    provider: 'copilot',
    session: null,
    weekly: null,
    monthly: totals.window,
    allowance: totals.allowance,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'web' }
  }
}

export function buildCopilotEntitlementSnapshot(payload: unknown): ProviderRateLimits | null {
  if (!isRecord(payload) || !isRecord(payload.quota_snapshots)) {
    return null
  }
  const quota = payload.quota_snapshots.premium_interactions
  if (!isRecord(quota)) {
    return null
  }
  const used = readFiniteNumber(quota.credits_used)
  const limit = readFiniteNumber(quota.entitlement)
  if (used === null || limit === null || limit <= 0) {
    return null
  }
  const parsedReset =
    typeof payload.quota_reset_date_utc === 'string'
      ? Date.parse(payload.quota_reset_date_utc)
      : Number.NaN
  const resetsAt = Number.isFinite(parsedReset) ? parsedReset : readNextMonthStartUtc()
  return buildCopilotSnapshot({
    allowance: {
      unit: { kind: 'count', label: 'AI credits' },
      used,
      limit,
      resetsAt
    },
    window: {
      usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
      windowMinutes: COPILOT_MONTHLY_WINDOW_MINUTES,
      resetsAt,
      resetDescription: null
    }
  })
}
