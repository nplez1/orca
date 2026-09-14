/**
 * Protobuf-Money-shaped amount. `nanos` is kept separate from `units` so sums
 * stay exact: Fireworks quotes 9-decimal nanos, which does not survive a float
 * round-trip.
 */
export type MoneyAmount = {
  /**
   * ISO 4217 code exactly as the provider stated it, so consumers must never
   * assume USD.
   */
  currencyCode: string
  /** Whole currency units, base-10 integer string (negative for debits). */
  units: string
  /** Fractional nanos, -999999999..999999999, carrying the sign of `units`. */
  nanos: number
}

const NANOS_PER_UNIT = 1_000_000_000n
const NANOS_DIGITS = 9
const DECIMAL_AMOUNT = /^(-?)(\d+)(?:\.(\d+))?$/
const INTEGER = /^-?\d+$/

/** Null when the provider sent something that is not a plain decimal. */
export function moneyFromDecimalString(currencyCode: string, value: string): MoneyAmount | null {
  const match = DECIMAL_AMOUNT.exec(value.trim())
  if (!match) {
    return null
  }
  const [, sign = '', whole = '', fraction = ''] = match
  // Why: build nanos as an integer instead of parsing the decimal as a float —
  // an 8-decimal balance loses its last digits before we ever read them.
  const magnitude =
    BigInt(whole) * NANOS_PER_UNIT +
    BigInt(fraction.padEnd(NANOS_DIGITS, '0').slice(0, NANOS_DIGITS))
  return fromTotalNanos(currencyCode, sign === '-' ? -magnitude : magnitude)
}

/** Protobuf `Money` (`units` string + `nanos` int). Null when either is malformed. */
export function moneyFromUnitsAndNanos(
  currencyCode: string,
  units: string,
  nanos: number
): MoneyAmount | null {
  const trimmedUnits = units.trim()
  if (!INTEGER.test(trimmedUnits) || !Number.isInteger(nanos)) {
    return null
  }
  return fromTotalNanos(currencyCode, BigInt(trimmedUnits) * NANOS_PER_UNIT + BigInt(nanos))
}

/**
 * One amount per currency, currency code ascending so a readout never reshuffles
 * between polls. Callers sum cross-currency line items this way rather than
 * adding unlike units together.
 */
export function sumMoneyByCurrency(amounts: readonly MoneyAmount[]): MoneyAmount[] {
  const totals = new Map<string, bigint>()
  for (const amount of amounts) {
    totals.set(amount.currencyCode, (totals.get(amount.currencyCode) ?? 0n) + toTotalNanos(amount))
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currencyCode, total]) => fromTotalNanos(currencyCode, total))
}

/**
 * Headline pick for a single-line readout: USD when present, else the first
 * currency the provider listed.
 */
export function pickMoneyForDisplay(amounts: readonly MoneyAmount[]): MoneyAmount | null {
  return amounts.find((amount) => amount.currencyCode.toUpperCase() === 'USD') ?? amounts[0] ?? null
}

export function isZeroMoney(amount: MoneyAmount): boolean {
  return toTotalNanos(amount) === 0n
}

/** Display-only float. Never use the result for arithmetic. */
export function moneyToNumber(amount: MoneyAmount): number {
  return Number(amount.units) + amount.nanos / 1_000_000_000
}

function fromTotalNanos(currencyCode: string, totalNanos: bigint): MoneyAmount {
  const negative = totalNanos < 0n
  const magnitude = negative ? -totalNanos : totalNanos
  const units = magnitude / NANOS_PER_UNIT
  return {
    currencyCode,
    // Why: sign the whole-unit part only when it is non-zero. A sub-unit debit such
    // as -0.50 would otherwise render `units: '-0'`, breaking the type's stated
    // invariant; there `nanos` carries the sign alone.
    units: `${negative && units !== 0n ? '-' : ''}${units}`,
    nanos: Number(negative ? -(magnitude % NANOS_PER_UNIT) : magnitude % NANOS_PER_UNIT)
  }
}

function toTotalNanos(amount: MoneyAmount): bigint {
  return BigInt(amount.units) * NANOS_PER_UNIT + BigInt(amount.nanos)
}
