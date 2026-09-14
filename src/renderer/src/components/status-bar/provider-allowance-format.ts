import { translate } from '@/i18n/i18n'
import type { MoneyAmount } from '../../../../shared/money-amount'
import type {
  ProviderAllowance,
  ProviderAllowanceUnit
} from '../../../../shared/provider-allowance'
import { activeLocale, formatCreditsAmount } from './provider-credits-format'

/** Float → the `MoneyAmount` shape the shared money renderer takes (display-only). */
function allowanceMoney(currencyCode: string, value: number): MoneyAmount {
  const units = Math.trunc(value)
  return {
    currencyCode,
    units: String(units),
    nanos: Math.round((value - units) * 1_000_000_000)
  }
}

/** Grouped whole counts: the provider's 10048.95 credits read as `10,049`. */
function formatAllowanceCount(value: number): string {
  try {
    return new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 0 }).format(value)
  } catch {
    return String(Math.round(value))
  }
}

function formatAllowanceValue(unit: ProviderAllowanceUnit, value: number): string {
  if (unit.kind === 'money') {
    // Why: route money through the credits renderer so an unrecognised currency
    // code degrades there instead of throwing out of a second formatter.
    return formatCreditsAmount(allowanceMoney(unit.currencyCode, value))
  }
  return formatAllowanceCount(value)
}

/**
 * Translated unit label for a count. The label is the provider's own string
 * (`credit` today), so an unrecognised one has to pass through verbatim rather than
 * vanish from the sentence; a blank one collapses to no unit at all.
 */
function formatAllowanceUnitLabel(label: string): string {
  const trimmed = label.trim()
  if (!trimmed) {
    return ''
  }
  if (trimmed.toLowerCase() === 'credit') {
    // Why: a translated label rather than appending an "s", which only pluralises in English.
    return translate('auto.components.status.bar.providerAllowance.unit.credit', 'credits')
  }
  return trimmed
}

/**
 * One-line amount readout: `$192.68 of $8,000.00`, `10,049 of 52,000 credits`.
 * `resetsAt` is deliberately excluded — window rows own reset copy, and the
 * percentage the user reads comes from the provider, never from these figures.
 */
export function describeAllowance(allowance: ProviderAllowance): string {
  const value0 = formatAllowanceValue(allowance.unit, allowance.used)
  const value1 = formatAllowanceValue(allowance.unit, allowance.limit)
  const unit = allowance.unit.kind === 'count' ? formatAllowanceUnitLabel(allowance.unit.label) : ''

  if (!unit) {
    return translate(
      'auto.components.status.bar.providerAllowance.usedOfLimit',
      '{{value0}} of {{value1}}',
      { value0, value1 }
    )
  }
  return translate(
    'auto.components.status.bar.providerAllowance.usedOfLimitUnit',
    '{{value0}} of {{value1}} {{value2}}',
    { value0, value1, value2: unit }
  )
}
