import { getIntlLocale, translate } from '@/i18n/i18n'
import { moneyToNumber, type MoneyAmount } from '../../../../shared/money-amount'
import type {
  ProviderCredits,
  ProviderCreditsItemKey,
  ProviderCreditsPeriod
} from '../../../../shared/provider-credits'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

// Why: tests replace the i18n module with a translate-only stub, so the locale
// read is best-effort — a missing accessor falls back to the runtime locale.
function activeLocale(): string | undefined {
  try {
    return getIntlLocale()
  } catch {
    return undefined
  }
}

/**
 * Money in the amount's own currency: DeepSeek answers in CNY for CN accounts.
 * `Intl` throws a RangeError on a currency code it does not recognize, and a
 * provider-supplied code crosses IPC unchecked, so an unformattable amount must
 * degrade rather than blank the whole status bar.
 */
export function formatCreditsAmount(amount: MoneyAmount): string {
  const value = moneyToNumber(amount)
  try {
    return new Intl.NumberFormat(activeLocale(), {
      style: 'currency',
      currency: amount.currencyCode
    }).format(value)
  } catch {
    return `${amount.currencyCode} ${value.toFixed(2)}`
  }
}

// Labels cross IPC as tokens, so the wording lives with the renderer. These are
// hand-authored semantic keys: the strings are not JSX, so the codemod cannot
// derive keys for them the way it does for component copy.

/** Null when the snapshot carries no period (or one this version doesn't know). */
export function formatCreditsPeriod(
  period: ProviderCreditsPeriod | null | undefined
): string | null {
  if (period === 'current-month') {
    return translate('auto.components.status.bar.providerCredits.period.currentMonth', 'this month')
  }
  if (period === 'last-30-days') {
    return translate(
      'auto.components.status.bar.providerCredits.period.last30Days',
      'in the last 30 days'
    )
  }
  return null
}

export function formatCreditsItemLabel(key: ProviderCreditsItemKey): string {
  if (key === 'granted') {
    return translate('auto.components.status.bar.providerCredits.item.granted', 'Granted')
  }
  if (key === 'topped-up') {
    return translate('auto.components.status.bar.providerCredits.item.toppedUp', 'Topped up')
  }
  // Why: an unknown token from a newer main must not render as a blank row.
  return key
}

/** Single predicate for "this provider has a credits readout instead of windows". */
export function hasCreditsData(provider: ProviderRateLimits): boolean {
  return provider.credits != null
}

/** One-line headline: `$42.10 available`, `$18.44 spent this month`. */
export function describeCredits(credits: ProviderCredits): string {
  const amount = formatCreditsAmount(credits.amount)
  if (credits.kind === 'balance') {
    return translate('auto.components.status.bar.providerCredits.balance', '{{value0}} available', {
      value0: amount
    })
  }
  const period = formatCreditsPeriod(credits.period)
  if (!period) {
    return translate('auto.components.status.bar.providerCredits.spend', '{{value0}} spent', {
      value0: amount
    })
  }
  return translate(
    'auto.components.status.bar.providerCredits.spendPeriod',
    '{{value0}} spent {{value1}}',
    { value0: amount, value1: period }
  )
}

export type CreditsItemRow = {
  key: ProviderCreditsItemKey
  label: string
  amount: string
}

/** Pre-formatted `granted` / `topped up` split for the detail panel. */
export function creditsItemRows(credits: ProviderCredits): CreditsItemRow[] {
  return (credits.items ?? []).map((item) => ({
    key: item.key,
    label: formatCreditsItemLabel(item.key),
    amount: formatCreditsAmount(item.amount)
  }))
}
