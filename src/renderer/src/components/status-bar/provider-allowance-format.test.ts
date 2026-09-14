import { describe, expect, it, vi } from 'vitest'
import type { ProviderAllowance } from '../../../../shared/provider-allowance'

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

import { describeAllowance } from './provider-allowance-format'

function moneyAllowance(
  currencyCode: string,
  used: number,
  limit: number,
  resetsAt: number | null = null
): ProviderAllowance {
  return { unit: { kind: 'money', currencyCode }, used, limit, resetsAt }
}

function countAllowance(
  label: string,
  used: number,
  limit: number,
  resetsAt: number | null = null
): ProviderAllowance {
  return { unit: { kind: 'count', label }, used, limit, resetsAt }
}

describe('describeAllowance', () => {
  it('formats Claude’s monthly spend cap in the allowance’s own currency', () => {
    expect(describeAllowance(moneyAllowance('USD', 192.68, 8000))).toBe('$192.68 of $8,000.00')
  })

  it('reads the same amount line when the provider reports a reset', () => {
    // Why: reset copy belongs to the window rows; a second countdown on the amount
    // line would duplicate it and go stale against the shared clock.
    expect(describeAllowance(moneyAllowance('USD', 192.68, 8000, 1_800_000_000_000))).toBe(
      '$192.68 of $8,000.00'
    )
  })

  it('groups a count and appends the provider’s unit label', () => {
    expect(describeAllowance(countAllowance('credit', 10048.95, 52_000, 1_800_000_000_000))).toBe(
      '10,049 of 52,000 credits'
    )
  })

  it('passes an unrecognised unit label through verbatim', () => {
    // Why: the label is the provider's own string, so a unit Orca does not know still
    // has to render rather than silently losing the noun.
    expect(describeAllowance(countAllowance('token', 3, 10))).toBe('3 of 10 token')
  })

  it('collapses an empty or unknown count label instead of leaving a gap', () => {
    // Why: labels cross IPC unchecked, so a blank one must not render '3 of 10 '.
    expect(describeAllowance(countAllowance('   ', 3, 10))).toBe('3 of 10')
    expect(describeAllowance(countAllowance('', 3, 10))).toBe('3 of 10')
  })

  it('degrades an unrecognised currency code instead of throwing', () => {
    // Why: Intl throws RangeError on a code it does not recognize and the code
    // crosses IPC unchecked — a throw here would blank the whole status bar.
    expect(() => describeAllowance(moneyAllowance('NOTACODE', 192.68, 8000))).not.toThrow()
    expect(describeAllowance(moneyAllowance('NOTACODE', 192.68, 8000))).toBe(
      'NOTACODE 192.68 of NOTACODE 8000.00'
    )
  })

  it('renders a zero ceiling without dividing or printing NaN', () => {
    expect(describeAllowance(moneyAllowance('USD', 0, 0))).toBe('$0.00 of $0.00')
    expect(describeAllowance(countAllowance('credit', 0, 0))).toBe('0 of 0 credits')
    expect(describeAllowance(moneyAllowance('USD', 0, 0))).not.toContain('NaN')
  })
})

describe('catalog keys', () => {
  // Why: these are hand-authored semantic keys sitting under the `auto.` prefix the
  // sibling providerCredits keys use, so the catalog sync depends on the exact strings.
  it('routes every sentence through a semantic key', () => {
    mocks.translateKeys.length = 0

    describeAllowance(moneyAllowance('USD', 1, 2))
    describeAllowance(countAllowance('credit', 1, 2))

    expect(mocks.translateKeys).toEqual([
      'auto.components.status.bar.providerAllowance.usedOfLimit',
      'auto.components.status.bar.providerAllowance.unit.credit',
      'auto.components.status.bar.providerAllowance.usedOfLimitUnit'
    ])
  })
})
