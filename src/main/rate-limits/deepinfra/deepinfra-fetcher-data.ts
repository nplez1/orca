import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import type { ProviderCredits, ProviderCreditsItem } from '../../../shared/provider-credits'
import { moneyFromUnitsAndNanos, type MoneyAmount } from '../../../shared/money-amount'

// Why: pure data-shape helpers for DeepInfra's billing API. Kept out of
// deepinfra-fetcher.ts so the transport file stays a thin fetch + catch.

export const DEEPINFRA_API_BASE_URL = 'https://api.deepinfra.com'
// Why not /v1: the billing routes sit beside the inference routes, not under them.
export const DEEPINFRA_CHECKLIST_PATH = '/payment/checklist'
export const DEEPINFRA_REQUEST_TIMEOUT_MS = 10_000
// Why: DeepInfra bills in US dollars and publishes no per-account currency.
export const DEEPINFRA_DEFAULT_CURRENCY = 'USD'

/** The fields of `GET /payment/checklist` this readout consumes. */
export type DeepInfraChecklist = {
  /** Negative means funds ready to spend; positive means money owed. */
  stripe_balance?: unknown
  /** Usage since the most recent invoice, in dollars. */
  recent?: unknown
  suspended?: unknown
  overdue_invoices?: unknown
  billing_type?: unknown
}

export type DeepInfraFailureKind = NonNullable<ProviderRateLimits['usageMetadata']>['failureKind']

export function makeDeepInfraUnavailable(error: string): ProviderRateLimits {
  return {
    provider: 'deepinfra',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
  }
}

export function makeDeepInfraError(
  error: string,
  failureKind: DeepInfraFailureKind
): ProviderRateLimits {
  return {
    provider: 'deepinfra',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { failureKind, source: 'web' }
  }
}

export function makeDeepInfraSuccess(credits: ProviderCredits): ProviderRateLimits {
  return {
    provider: 'deepinfra',
    // Why: DeepInfra publishes no quota window, so only the money readout is rendered.
    session: null,
    weekly: null,
    credits,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'web' }
  }
}

/** Null when `cents` is not a safe integer, so a bad payload fails loudly instead of rounding. */
export function moneyFromCents(cents: number): MoneyAmount | null {
  if (!Number.isSafeInteger(cents)) {
    return null
  }
  const negative = cents < 0
  const magnitude = Math.abs(cents)
  const units = Math.floor(magnitude / 100)
  const nanos = (magnitude % 100) * 10_000_000
  return moneyFromUnitsAndNanos(
    DEEPINFRA_DEFAULT_CURRENCY,
    `${negative && units !== 0 ? '-' : ''}${units}`,
    negative ? -nanos : nanos
  )
}

/**
 * Dollars to integer cents. The API answers in dollars (a float), so the
 * conversion happens once here rather than in float arithmetic downstream.
 */
function toCents(value: unknown): number | null {
  // Why: JSON omits nothing here, but a null/absent field means "no amount" and
  // DeepInfra's own dashboard reads that as zero.
  if (value === undefined || value === null) {
    return 0
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return Math.round(value * 100)
}

/**
 * Remaining dollars, mirroring DeepInfra's own dashboard: `-(stripe_balance + recent)`.
 *
 * Why the sum: `stripe_balance` is the credit on the account and `recent` is the
 * usage incurred since the last invoice, which that credit has not been billed
 * for yet. Showing the credit alone would overstate what is actually spendable.
 *
 * Null when a field is unreadable — a wrong balance is worse than an error the
 * user can see.
 */
export function buildDeepInfraCredits(payload: DeepInfraChecklist): ProviderCredits | null {
  const balanceCents = toCents(payload.stripe_balance)
  const recentCents = toCents(payload.recent)
  if (balanceCents === null || recentCents === null) {
    return null
  }
  const remainingCents = -(balanceCents + recentCents)
  const amount = moneyFromCents(remainingCents)
  if (!amount) {
    return null
  }
  const items: ProviderCreditsItem[] = []
  const unbilled = moneyFromCents(recentCents)
  if (unbilled && recentCents !== 0) {
    items.push({ key: 'unbilled', amount: unbilled })
  }
  return {
    kind: 'balance',
    amount,
    items,
    // Why: an exhausted or suspended account stays visible so it can be topped up,
    // which is what DeepInfra's own "balance missing" banner means.
    available: remainingCents > 0 && payload.suspended !== true
  }
}
