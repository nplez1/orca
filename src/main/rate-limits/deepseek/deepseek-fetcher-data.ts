import type { ProviderRateLimits, UsageRateLimitMetadata } from '../../../shared/rate-limit-types'
import type { ProviderCredits, ProviderCreditsItem } from '../../../shared/provider-credits'
import {
  moneyFromDecimalString,
  pickMoneyForDisplay,
  type MoneyAmount
} from '../../../shared/money-amount'

// Why: pure data-shape helpers for DeepSeek's balance API. Split from the
// transport file so deepseek-fetcher.ts and deepseek-fetcher-parse.ts can both
// import without a dependency cycle.

export type DeepSeekBalanceInfo = {
  currency?: unknown
  total_balance?: unknown
  granted_balance?: unknown
  topped_up_balance?: unknown
}

export type DeepSeekBalanceResponse = {
  is_available?: unknown
  balance_infos?: unknown
}

export function makeDeepSeekUnavailable(error: string): ProviderRateLimits {
  return {
    provider: 'deepseek',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
  }
}

export function makeDeepSeekError(
  error: string,
  failureKind: NonNullable<UsageRateLimitMetadata['failureKind']>
): ProviderRateLimits {
  return {
    provider: 'deepseek',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { failureKind, source: 'web' }
  }
}

function parseAmount(currencyCode: string, value: unknown): MoneyAmount | null {
  // Why: DeepSeek quotes balances as decimal strings; a non-string or garbage
  // value must drop the readout rather than be coerced through float math.
  return typeof value === 'string' ? moneyFromDecimalString(currencyCode, value) : null
}

function parseBalanceItems(info: DeepSeekBalanceInfo, currencyCode: string): ProviderCreditsItem[] {
  const items: ProviderCreditsItem[] = []
  const granted = parseAmount(currencyCode, info.granted_balance)
  if (granted) {
    items.push({ key: 'granted', amount: granted })
  }
  const toppedUp = parseAmount(currencyCode, info.topped_up_balance)
  if (toppedUp) {
    items.push({ key: 'topped-up', amount: toppedUp })
  }
  return items
}

/**
 * Null when no balance entry carries a readable decimal total — the caller
 * reports that as a parse failure rather than a zero balance.
 */
export function buildDeepSeekCredits(payload: DeepSeekBalanceResponse): ProviderCredits | null {
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : []
  const candidates: { amount: MoneyAmount; items: ProviderCreditsItem[] }[] = []
  for (const raw of infos) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue
    }
    const info: DeepSeekBalanceInfo = raw
    // Why: a CN account answers in CNY and an unknown code must reach the UI
    // verbatim — never coerced to USD.
    const currencyCode = typeof info.currency === 'string' ? info.currency.trim() : ''
    if (!currencyCode) {
      continue
    }
    const amount = parseAmount(currencyCode, info.total_balance)
    if (!amount) {
      continue
    }
    candidates.push({ amount, items: parseBalanceItems(info, currencyCode) })
  }
  // Why: prefers USD, else the first listed currency (DeepSeek lists CNY first
  // for CN accounts).
  const headline = pickMoneyForDisplay(candidates.map((candidate) => candidate.amount))
  const selected = candidates.find((candidate) => candidate.amount === headline)
  if (!headline || !selected) {
    return null
  }
  return {
    kind: 'balance',
    amount: selected.amount,
    items: selected.items,
    // Why: only an explicit false marks the account exhausted; a missing flag
    // must not raise the top-up warning.
    available: payload.is_available !== false
  }
}
