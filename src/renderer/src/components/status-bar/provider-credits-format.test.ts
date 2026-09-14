import { describe, expect, it, vi } from 'vitest'
import type { MoneyAmount } from '../../../../shared/money-amount'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { ProviderCredits } from '../../../../shared/provider-credits'

const mocks = vi.hoisted(() => {
  const translateKeys: string[] = []
  return { translateKeys }
})

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  getIntlLocale: () => 'en-US',
  translate: (key: string, fallback: string, values?: Record<string, string>) => {
    mocks.translateKeys.push(key)
    let result = fallback
    for (const [name, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${name}}}`, value)
    }
    return result
  }
}))

import {
  creditsItemRows,
  describeCredits,
  formatCreditsAmount,
  formatCreditsItemLabel,
  formatCreditsPeriod,
  hasCreditsData
} from './provider-credits-format'

function money(currencyCode: string, units: string, nanos = 0): MoneyAmount {
  return { currencyCode, units, nanos }
}

function provider(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'deepseek',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('formatCreditsAmount', () => {
  it('formats a USD balance with a currency symbol', () => {
    expect(formatCreditsAmount(money('USD', '42', 100_000_000))).toBe('$42.10')
  })

  it('formats a CNY balance in the amount’s own currency, never hardcoded USD', () => {
    // DeepSeek answers in CNY for CN accounts; the symbol must follow the amount.
    expect(formatCreditsAmount(money('CNY', '1234', 500_000_000))).toBe('CN¥1,234.50')
  })

  it('falls back to a code-prefixed number instead of throwing on an unknown code', () => {
    // Why: Intl throws RangeError on a code it does not recognize, and the code
    // crosses IPC unchecked — a throw here would blank the whole status bar.
    expect(() => formatCreditsAmount(money('NOTACODE', '5'))).not.toThrow()
    expect(formatCreditsAmount(money('NOTACODE', '5'))).toBe('NOTACODE 5.00')
  })
})

describe('formatCreditsPeriod / formatCreditsItemLabel', () => {
  it('maps period tokens to wording', () => {
    expect(formatCreditsPeriod('current-month')).toBe('this month')
    expect(formatCreditsPeriod('last-30-days')).toBe('in the last 30 days')
    expect(formatCreditsPeriod(null)).toBeNull()
    expect(formatCreditsPeriod(undefined)).toBeNull()
  })

  it('maps item tokens to labels', () => {
    expect(formatCreditsItemLabel('granted')).toBe('Granted')
    expect(formatCreditsItemLabel('topped-up')).toBe('Topped up')
    expect(formatCreditsItemLabel('spent-this-month')).toBe('Spent this month')
  })

  it('degrades tokens this build does not know instead of rendering blank', () => {
    // Why: tokens cross IPC, so a newer host can send one this renderer predates.
    // @ts-expect-error — deliberate unknown wire token.
    expect(formatCreditsPeriod('next-quarter')).toBeNull()
    // @ts-expect-error — deliberate unknown wire token.
    expect(formatCreditsItemLabel('refunded')).toBe('refunded')
  })
})

describe('describeCredits', () => {
  it('summarizes a balance', () => {
    const credits: ProviderCredits = { kind: 'balance', amount: money('USD', '42', 100_000_000) }
    expect(describeCredits(credits)).toBe('$42.10 available')
  })

  it('summarizes spend with its period', () => {
    const credits: ProviderCredits = {
      kind: 'spend',
      amount: money('USD', '18', 440_000_000),
      period: 'current-month'
    }
    expect(describeCredits(credits)).toBe('$18.44 spent this month')
  })

  it('summarizes spend without a period', () => {
    const credits: ProviderCredits = { kind: 'spend', amount: money('USD', '18', 440_000_000) }
    expect(describeCredits(credits)).toBe('$18.44 spent')
  })
})

describe('creditsItemRows', () => {
  it('pre-formats the granted / topped-up breakdown', () => {
    const credits: ProviderCredits = {
      kind: 'balance',
      amount: money('USD', '30'),
      items: [
        { key: 'granted', amount: money('USD', '10') },
        { key: 'topped-up', amount: money('USD', '20', 500_000_000) }
      ]
    }
    expect(creditsItemRows(credits)).toEqual([
      { key: 'granted', label: 'Granted', amount: '$10.00' },
      { key: 'topped-up', label: 'Topped up', amount: '$20.50' }
    ])
  })

  it('returns no rows when the provider publishes no breakdown', () => {
    expect(creditsItemRows({ kind: 'spend', amount: money('USD', '3') })).toEqual([])
  })

  it('renders an unknown item token as its raw key', () => {
    const credits: ProviderCredits = {
      kind: 'balance',
      amount: money('USD', '30'),
      items: [
        {
          // @ts-expect-error — a newer host can send an item token this build predates.
          key: 'refunded',
          amount: money('USD', '2')
        }
      ]
    }
    expect(creditsItemRows(credits)).toEqual([
      { key: 'refunded', label: 'refunded', amount: '$2.00' }
    ])
  })
})

describe('hasCreditsData', () => {
  it('is true only when a credits readout is present', () => {
    expect(hasCreditsData(provider())).toBe(false)
    expect(hasCreditsData(provider({ credits: null }))).toBe(false)
    expect(
      hasCreditsData(provider({ credits: { kind: 'balance', amount: money('USD', '1') } }))
    ).toBe(true)
  })
})

describe('catalog keys', () => {
  // Why: these are hand-authored semantic keys rather than codemod hashes, so
  // the catalog sync depends on the exact strings — pin them here.
  it('routes every label and sentence through a semantic key', () => {
    mocks.translateKeys.length = 0

    formatCreditsPeriod('current-month')
    formatCreditsPeriod('last-30-days')
    formatCreditsItemLabel('granted')
    formatCreditsItemLabel('topped-up')
    describeCredits({ kind: 'balance', amount: money('USD', '1') })
    describeCredits({ kind: 'spend', amount: money('USD', '1'), period: 'current-month' })
    describeCredits({ kind: 'spend', amount: money('USD', '1') })

    expect(mocks.translateKeys).toEqual([
      'auto.components.status.bar.providerCredits.period.currentMonth',
      'auto.components.status.bar.providerCredits.period.last30Days',
      'auto.components.status.bar.providerCredits.item.granted',
      'auto.components.status.bar.providerCredits.item.toppedUp',
      'auto.components.status.bar.providerCredits.balance',
      // describeCredits resolves the period through formatCreditsPeriod first.
      'auto.components.status.bar.providerCredits.period.currentMonth',
      'auto.components.status.bar.providerCredits.spendPeriod',
      'auto.components.status.bar.providerCredits.spend'
    ])
  })
})
