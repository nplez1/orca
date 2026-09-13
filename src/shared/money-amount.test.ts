import { describe, expect, it } from 'vitest'
import {
  isZeroMoney,
  moneyFromDecimalString,
  moneyFromUnitsAndNanos,
  moneyToNumber,
  pickMoneyForDisplay,
  sumMoneyByCurrency,
  type MoneyAmount
} from './money-amount'

describe('moneyFromDecimalString', () => {
  it('parses a plain decimal into exact whole units and nanos', () => {
    expect(moneyFromDecimalString('USD', '42.10')).toEqual({
      currencyCode: 'USD',
      units: '42',
      nanos: 100_000_000
    })
  })

  it('carries the sign on nanos alone for a sub-unit debit', () => {
    // Why: `units: '-0'` would contradict the type's stated invariant; -0.50 is
    // sign-carried entirely by nanos.
    expect(moneyFromDecimalString('USD', '-0.50')).toEqual({
      currencyCode: 'USD',
      units: '0',
      nanos: -500_000_000
    })
    expect(moneyToNumber(moneyFromDecimalString('USD', '-0.50')!)).toBe(-0.5)
  })

  it('pads a short fraction rather than reading it as whole units', () => {
    expect(moneyFromDecimalString('CNY', '7.5')).toEqual({
      currencyCode: 'CNY',
      units: '7',
      nanos: 500_000_000
    })
    expect(moneyFromDecimalString('CNY', '7')?.nanos).toBe(0)
  })

  it('truncates beyond nanos precision instead of rounding up', () => {
    // Why: truncation is toward zero for either sign, so a tenth decimal can
    // never inflate a balance.
    expect(moneyFromDecimalString('USD', '0.9999999999')?.nanos).toBe(999_999_999)
    expect(moneyFromDecimalString('USD', '-0.9999999999')?.nanos).toBe(-999_999_999)
  })

  it('tolerates surrounding whitespace', () => {
    expect(moneyFromDecimalString('USD', '  12.34  ')).toEqual({
      currencyCode: 'USD',
      units: '12',
      nanos: 340_000_000
    })
  })

  it.each(['', 'abc', '1e3', '.5', '1.2.3', 'NaN', '--1', '1,000'])(
    'returns null for a non-decimal value (%s)',
    (value) => {
      expect(moneyFromDecimalString('USD', value)).toBeNull()
    }
  )
})

describe('moneyFromUnitsAndNanos', () => {
  it('parses a protobuf Money into nanos', () => {
    expect(moneyFromUnitsAndNanos('USD', '18', 440_000_000)).toEqual({
      currencyCode: 'USD',
      units: '18',
      nanos: 440_000_000
    })
  })

  it('accepts a zero-units negative nanos (a legal Fireworks adjustment)', () => {
    expect(moneyFromUnitsAndNanos('USD', '0', -500_000_000)).toEqual({
      currencyCode: 'USD',
      units: '0',
      nanos: -500_000_000
    })
  })

  it.each([
    ['USD', 'abc', 0],
    ['USD', '1', 1.5],
    ['USD', '1e3', 0],
    ['USD', '', 0]
  ])('returns null for a malformed Money (%s, %s, %s)', (currency, units, nanos) => {
    expect(moneyFromUnitsAndNanos(currency, units, nanos)).toBeNull()
  })
})

describe('sumMoneyByCurrency', () => {
  it('sums a repeated tenth exactly, where float addition drifts', () => {
    const tenths: MoneyAmount[] = Array.from({ length: 10 }, () =>
      moneyFromDecimalString('USD', '0.1')!
    )
    expect(sumMoneyByCurrency(tenths)).toEqual([{ currencyCode: 'USD', units: '1', nanos: 0 }])
  })

  it('keeps unlike currencies in separate buckets, ordered by code', () => {
    const summed = sumMoneyByCurrency([
      moneyFromDecimalString('USD', '10')!,
      moneyFromDecimalString('CNY', '70')!,
      moneyFromDecimalString('USD', '2.50')!
    ])
    expect(summed).toEqual([
      { currencyCode: 'CNY', units: '70', nanos: 0 },
      { currencyCode: 'USD', units: '12', nanos: 500_000_000 }
    ])
  })

  it('cancels opposing amounts to an exact zero', () => {
    const summed = sumMoneyByCurrency([
      moneyFromDecimalString('USD', '42.10')!,
      moneyFromDecimalString('USD', '-42.10')!
    ])
    expect(summed).toEqual([{ currencyCode: 'USD', units: '0', nanos: 0 }])
    expect(isZeroMoney(summed[0]!)).toBe(true)
  })

  it('returns no buckets for no amounts', () => {
    expect(sumMoneyByCurrency([])).toEqual([])
  })
})

describe('pickMoneyForDisplay', () => {
  it('prefers USD over a CN account balance listed first', () => {
    const cny = moneyFromDecimalString('CNY', '70')!
    const usd = moneyFromDecimalString('USD', '10')!
    expect(pickMoneyForDisplay([cny, usd])).toBe(usd)
  })

  it('falls back to the first currency when USD is absent', () => {
    const cny = moneyFromDecimalString('CNY', '70')!
    expect(pickMoneyForDisplay([cny])).toBe(cny)
  })

  it('matches USD case-insensitively', () => {
    const lower = moneyFromDecimalString('usd', '10')!
    const cny = moneyFromDecimalString('CNY', '70')!
    expect(pickMoneyForDisplay([cny, lower])).toBe(lower)
  })

  it('returns null for no amounts', () => {
    expect(pickMoneyForDisplay([])).toBeNull()
  })
})

describe('isZeroMoney', () => {
  it('treats a zero-nanos amount as zero regardless of units spelling', () => {
    expect(isZeroMoney({ currencyCode: 'USD', units: '0', nanos: 0 })).toBe(true)
    expect(isZeroMoney({ currencyCode: 'USD', units: '0', nanos: -1 })).toBe(false)
  })
})
