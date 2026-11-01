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

const NANOS_PER_UNIT = 1_000_000_000

/** Null when `totalNanos` is not a safe integer, so a bad payload fails loudly instead of rounding. */
export function moneyFromNanos(totalNanos: number): MoneyAmount | null {
  if (!Number.isSafeInteger(totalNanos)) {
    return null
  }
  const units = Math.trunc(totalNanos / NANOS_PER_UNIT)
  return moneyFromUnitsAndNanos(
    DEEPINFRA_DEFAULT_CURRENCY,
    String(units),
    totalNanos - units * NANOS_PER_UNIT
  )
}

/**
 * Dollars to integer nanos. DeepInfra answers in dollars as a JSON float, so the
 * conversion happens once here rather than in float arithmetic downstream.
 *
 * Why nanos and not cents: `recent` is metered usage with sub-cent precision, and
 * rounding each field to cents before adding them can put the readout a cent away
 * from the dashboard's own figure. The formatter rounds once, at display time.
 *
 * Undefined/null is "no amount" and reads as zero; a present value that is not a
 * finite number is unreadable, and null says so rather than being coerced.
 */
function toNanos(value: unknown): number | null {
  if (value === undefined || value === null) {
    return 0
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return Math.round(value * NANOS_PER_UNIT)
}

/**
 * Only an explicit `'balance'` billing type is known to be prepaid, and a prepaid
 * account is the one that stops working at zero credit. An absent or unfamiliar
 * type therefore claims nothing: this API has only ever answered `'balance'`, and
 * asserting exhaustion on a guess would put a false warning in the tooltip.
 */
function isPrepaid(payload: DeepInfraChecklist): boolean {
  return payload.billing_type === 'balance'
}

/**
 * Remaining dollars, mirroring DeepInfra's own dashboard: `-(stripe_balance + recent)`.
 *
 * Why the sum: `stripe_balance` is the credit on the account and `recent` is the
 * usage incurred since the last invoice, which that credit has not been billed
 * for yet. Showing the credit alone would overstate what is actually spendable.
 *
 * Null when the payload cannot be read — a wrong balance is worse than an error
 * the user can see.
 */
export function buildDeepInfraCredits(payload: DeepInfraChecklist): ProviderCredits | null {
  // Why: unlike Fireworks' protobuf payload, this API answers plain JSON, which
  // serializes a zero as 0 instead of omitting it. A payload carrying neither
  // amount is therefore not an empty account but a shape this code no longer
  // understands, and a confident $0.00 would be worse than a parse error.
  if (payload.stripe_balance == null && payload.recent == null) {
    return null
  }
  const balanceNanos = toNanos(payload.stripe_balance)
  const recentNanos = toNanos(payload.recent)
  if (balanceNanos === null || recentNanos === null) {
    return null
  }
  const remainingNanos = -(balanceNanos + recentNanos)
  const amount = moneyFromNanos(remainingNanos)
  if (!amount) {
    return null
  }
  const items: ProviderCreditsItem[] = []
  const unbilled = moneyFromNanos(recentNanos)
  // Why the half-cent floor: a sub-cent `recent` renders as "Unbilled usage $0.00",
  // which is a line of noise rather than a breakdown.
  if (unbilled && Math.abs(recentNanos) >= NANOS_PER_UNIT / 200) {
    items.push({ key: 'unbilled', amount: unbilled })
  }
  // Why billing_type: only a prepaid account stops working at zero credit. An
  // invoice-billed account runs at about zero by design, so calling that exhausted
  // would put a false "cannot fund further calls" warning in the tooltip.
  const exhausted = isPrepaid(payload) && remainingNanos <= 0
  return {
    kind: 'balance',
    amount,
    items,
    // Why keep it visible: an exhausted or suspended account still needs its
    // readout, so it can be topped up rather than vanishing from the bar.
    available: payload.suspended !== true && !exhausted
  }
}
