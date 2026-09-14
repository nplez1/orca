import { getIntlLocale } from '@/i18n/i18n'
import { moneyToNumber, type MoneyAmount } from '../../../../shared/money-amount'

// Why: tests replace the i18n module with a translate-only stub, so the locale
// read is best-effort — a missing accessor falls back to the runtime locale.
// Shared with provider-allowance-format so both formatters degrade identically.
export function activeLocale(): string | undefined {
  try {
    return getIntlLocale()
  } catch {
    return undefined
  }
}

/**
 * Money in the amount's own currency: an API-key provider can answer in CNY for
 * CN accounts. `Intl` throws a RangeError on a currency code it does not
 * recognize, and a provider-supplied code crosses IPC unchecked, so an
 * unformattable amount must degrade rather than blank the whole status bar.
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
