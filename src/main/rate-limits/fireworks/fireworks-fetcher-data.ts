import {
  moneyFromUnitsAndNanos,
  pickMoneyForDisplay,
  sumMoneyByCurrency,
  type MoneyAmount
} from '../../../shared/money-amount'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'

// Why: pure data-shape helpers for the Fireworks billing API. Kept out of
// fireworks-fetcher.ts so the transport file stays under the line cap and these
// shapes stay testable without electron loaded.

export const FIREWORKS_API_BASE_URL = 'https://api.fireworks.ai'
export const FIREWORKS_REQUEST_TIMEOUT_MS = 10_000
// Why: Fireworks publishes no account currency, and a zero readout still needs
// one. Rated costs are quoted in USD, so that is the default for a no-usage account.
export const FIREWORKS_DEFAULT_CURRENCY = 'USD'

export type FireworksFailureKind = NonNullable<ProviderRateLimits['usageMetadata']>['failureKind']

export type FireworksSpendResult = { status: 'ok'; amount: MoneyAmount } | { status: 'malformed' }

export function makeFireworksZeroSpend(): MoneyAmount {
  return { currencyCode: FIREWORKS_DEFAULT_CURRENCY, units: '0', nanos: 0 }
}

// Why: Fireworks rates costs from usage at the account level; the final invoice
// can differ once credits and adjustments are applied.
export function makeFireworksSuccess(amount: MoneyAmount): ProviderRateLimits {
  return {
    provider: 'fireworks',
    session: null,
    weekly: null,
    credits: { kind: 'spend', amount, period: 'current-month' },
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'web' }
  }
}

// Why: 'unavailable' means "not configured" and is the value that hides a
// provider from the status bar, so only a missing credential may return it.
export function makeFireworksUnavailable(error: string): ProviderRateLimits {
  return {
    provider: 'fireworks',
    session: null,
    weekly: null,
    credits: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
  }
}

export function makeFireworksError(
  error: string,
  failureKind: FireworksFailureKind
): ProviderRateLimits {
  return {
    provider: 'fireworks',
    session: null,
    weekly: null,
    credits: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { failureKind, source: 'web' }
  }
}

export type FireworksMoneyPayload = {
  currencyCode?: unknown
  units?: unknown
  nanos?: unknown
}

// Why: proto3 JSON omits zero-valued scalars, so an absent `units`/`nanos` is a
// zero amount, while a present-but-unparseable one is a malformed payload.
function readMoneyUnits(value: unknown): string | null {
  if (value === undefined || value === null) {
    return '0'
  }
  if (typeof value === 'string') {
    return value
  }
  return typeof value === 'number' && Number.isInteger(value) ? String(value) : null
}

function readMoneyNanos(value: unknown): number | null {
  if (value === undefined || value === null) {
    return 0
  }
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/** Protobuf `Money`. Null when the shape is not a full amount. */
export function parseFireworksMoney(value: unknown): MoneyAmount | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const money: FireworksMoneyPayload = value
  const currencyCode = typeof money.currencyCode === 'string' ? money.currencyCode.trim() : ''
  const units = readMoneyUnits(money.units)
  const nanos = readMoneyNanos(money.nanos)
  if (units === null || nanos === null) {
    return null
  }
  if (!currencyCode) {
    // Why: proto3 JSON omits zero scalars, so a zero-rated `totalCost` arrives as
    // `{}` with no currency at all. That is a real $0.00 line, not a malformed
    // one — only a *non-zero* amount without a currency is unattributable.
    return units.trim() === '0' && nanos === 0 ? makeFireworksZeroSpend() : null
  }
  return moneyFromUnitsAndNanos(currencyCode, units, nanos)
}

/**
 * Exact total of per-line-item costs. Empty input is a zero spend in the
 * default currency, not an error: a new account legitimately has nothing yet.
 *
 * Why the shared helper: `units + nanos/1e9` drifts once several line items are
 * added (0.1 ten times is 0.9999999999999999), so sums stay in integer nanos.
 */
export function sumFireworksCosts(amounts: readonly MoneyAmount[]): MoneyAmount {
  return pickMoneyForDisplay(sumMoneyByCurrency(amounts)) ?? makeFireworksZeroSpend()
}
