import { describe, expect, it } from 'vitest'
import {
  EPHEMERAL_VM_LIFETIME_DURATION_LIMITS,
  EPHEMERAL_VM_LIFETIME_USER_DATA_KEYS,
  formatEphemeralVmCountdown,
  formatEphemeralVmLifetimeDuration,
  formatEphemeralVmRemaining,
  getEphemeralVmRemainingMs,
  isEphemeralVmLifetimeExpired,
  normalizeEphemeralVmLifetimeDuration,
  parseEphemeralVmLifetimeDuration,
  readEphemeralVmLifetime,
  type EphemeralVmLifetime
} from './ephemeral-vm-lifetime'

const RELEASE_AT = '2026-10-13T03:26:41Z'
const RELEASE_AT_MS = Date.parse(RELEASE_AT)

describe('parseEphemeralVmLifetimeDuration', () => {
  it.each([
    ['1m', 60],
    ['30m', 1_800],
    ['1h', 3_600],
    ['4h', 14_400],
    ['1d', 86_400],
    ['30d', 2_592_000]
  ])('parses %s as %i seconds', (value, seconds) => {
    expect(parseEphemeralVmLifetimeDuration(value)).toBe(seconds)
  })

  it.each([
    ['2H', 7_200],
    ['1D', 86_400],
    ['30M', 1_800],
    ['90S', 90],
    ['4H', 14_400]
  ])('accepts the upper-case unit in %s', (value, seconds) => {
    expect(parseEphemeralVmLifetimeDuration(value)).toBe(seconds)
  })

  it.each([
    ['  2h  ', 7_200],
    ['\t4h\n', 14_400],
    [' 1d ', 86_400]
  ])('ignores surrounding whitespace in %j', (value, seconds) => {
    expect(parseEphemeralVmLifetimeDuration(value)).toBe(seconds)
  })

  it('accepts exactly the lower bound and rejects one second below it', () => {
    expect(parseEphemeralVmLifetimeDuration('60s')).toBe(
      EPHEMERAL_VM_LIFETIME_DURATION_LIMITS.minSeconds
    )
    expect(parseEphemeralVmLifetimeDuration('1m')).toBe(
      EPHEMERAL_VM_LIFETIME_DURATION_LIMITS.minSeconds
    )
    expect(parseEphemeralVmLifetimeDuration('59s')).toBeNull()
  })

  it('accepts exactly the upper bound and rejects anything above it', () => {
    expect(parseEphemeralVmLifetimeDuration('30d')).toBe(
      EPHEMERAL_VM_LIFETIME_DURATION_LIMITS.maxSeconds
    )
    expect(parseEphemeralVmLifetimeDuration('721h')).toBeNull()
    expect(parseEphemeralVmLifetimeDuration('31d')).toBeNull()
  })

  it.each(['0s', '0m', '0h', '0d', '00s'])('rejects the zero duration %s', (value) => {
    expect(parseEphemeralVmLifetimeDuration(value)).toBeNull()
  })

  it.each(['', 'h', '1', '1h30m', '1.5h', '-1h', 'abc', '1 h', '1hh', '60 s'])(
    'rejects the malformed duration %j',
    (value) => {
      expect(parseEphemeralVmLifetimeDuration(value)).toBeNull()
    }
  )

  it('rejects a numeric part longer than the parser reads, even when the unit is valid', () => {
    // Why: the digit cap is what stops an overflowing amount from reaching the bound check.
    expect(parseEphemeralVmLifetimeDuration('2592001s')).toBeNull()
    expect(parseEphemeralVmLifetimeDuration('9999999m')).toBeNull()
  })
})

describe('formatEphemeralVmLifetimeDuration', () => {
  it.each([
    [60, '1m'],
    [1_800, '30m'],
    [3_600, '1h'],
    [14_400, '4h'],
    [86_400, '1d'],
    [172_800, '2d'],
    [2_592_000, '30d'],
    [90, '90s'],
    [90_061, '90061s']
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(formatEphemeralVmLifetimeDuration(seconds)).toBe(expected)
  })
})

describe('normalizeEphemeralVmLifetimeDuration', () => {
  it.each([
    ['24h', '1d'],
    ['120m', '2h'],
    ['60m', '1h'],
    ['3600s', '1h'],
    ['86400s', '1d'],
    ['90s', '90s'],
    ['4h', '4h'],
    ['30m', '30m']
  ])('canonicalizes %s to %s', (value, expected) => {
    expect(normalizeEphemeralVmLifetimeDuration(value)).toBe(expected)
  })

  it.each(['59s', '31d', '1h30m', 'nope', ''])(
    'returns null for the unusable value %j',
    (value) => {
      expect(normalizeEphemeralVmLifetimeDuration(value)).toBeNull()
    }
  )

  it('round-trips every canonical spelling back to its own seconds', () => {
    for (const seconds of [60, 90, 3_600, 14_400, 86_400, 172_800, 2_592_000]) {
      const canonical = formatEphemeralVmLifetimeDuration(seconds)
      expect(parseEphemeralVmLifetimeDuration(canonical)).toBe(seconds)
      expect(normalizeEphemeralVmLifetimeDuration(canonical)).toBe(canonical)
    }
  })

  it('is idempotent under repeated normalization', () => {
    for (const value of ['24h', '120m', '86400s', '4h']) {
      const once = normalizeEphemeralVmLifetimeDuration(value)
      expect(once === null ? null : normalizeEphemeralVmLifetimeDuration(once)).toBe(once)
    }
  })
})

describe('readEphemeralVmLifetime', () => {
  it.each([undefined, null, 'not an object', 42, [], ['releaseAt']])(
    'treats %j as having no lifetime',
    (userData) => {
      expect(readEphemeralVmLifetime(userData)).toEqual({ ok: true, lifetime: null })
    }
  )

  it.each([
    { provider: 'aws' },
    { resourceId: 'i-0123456789' },
    { lifetimeSeconds: 3_600 },
    { provider: 'aws', resourceId: 'i-0123456789', lifetimeSeconds: 3_600 },
    { provider: 'aws', unrelated: { nested: true } }
  ])('treats %j as having no lifetime, because only releaseAt opts a recipe in', (userData) => {
    expect(readEphemeralVmLifetime(userData)).toEqual({ ok: true, lifetime: null })
  })

  it('stays backward compatible with a recipe that sets provider and the sibling keys but no releaseAt', () => {
    // Why: `provider` is a common key for recipes that predate this contract, so its presence
    // must never be read as a lifetime declaration.
    expect(
      readEphemeralVmLifetime({
        provider: 'aws',
        resourceId: 'i-0123456789',
        lifetimeSeconds: 3_600
      })
    ).toEqual({ ok: true, lifetime: null })
  })

  it('reads a UTC deadline exactly as the provider reported it', () => {
    expect(
      readEphemeralVmLifetime({
        provider: 'aws',
        resourceId: 'i-0123456789',
        releaseAt: RELEASE_AT,
        lifetimeSeconds: 3_600
      })
    ).toEqual({
      ok: true,
      lifetime: {
        provider: 'aws',
        resourceId: 'i-0123456789',
        releaseAt: RELEASE_AT,
        releaseAtMs: RELEASE_AT_MS,
        lifetimeSeconds: 3_600
      }
    })
  })

  it.each(['2026-10-13T05:26:41+02:00', '2026-10-12T22:26:41-05:00'])(
    'accepts the offset deadline %s',
    (releaseAt) => {
      const read = readEphemeralVmLifetime({ releaseAt })
      expect(read.ok).toBe(true)
      if (read.ok) {
        expect(read.lifetime?.releaseAt).toBe(releaseAt)
        expect(read.lifetime?.releaseAtMs).toBe(RELEASE_AT_MS)
      }
    }
  )

  it.each([
    '2026-10-13T03:26:41',
    '2026-10-13',
    '2026-10-13T03:26:41+0200',
    'tomorrow',
    '',
    null,
    '1791871601000',
    1_791_871_601_000
  ])('rejects the malformed releaseAt %j with a field-naming error', (releaseAt) => {
    const read = readEphemeralVmLifetime({ releaseAt })
    expect(read.ok).toBe(false)
    if (!read.ok) {
      expect(read.error).toContain('userData.releaseAt')
      expect(read.error).toContain('RFC 3339')
    }
  })

  it('reports a releaseAt-shaped error when only the deadline is unusable', () => {
    expect(readEphemeralVmLifetime({ provider: 'aws', releaseAt: 'nope' })).toEqual({
      ok: false,
      error: `userData.${EPHEMERAL_VM_LIFETIME_USER_DATA_KEYS.releaseAt} must be an RFC 3339 timestamp with an offset, such as 2026-10-13T03:26:41Z.`
    })
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3600'])(
    'rejects the unusable lifetimeSeconds %j',
    (lifetimeSeconds) => {
      const read = readEphemeralVmLifetime({ releaseAt: RELEASE_AT, lifetimeSeconds })
      expect(read.ok).toBe(false)
      if (!read.ok) {
        expect(read.error).toContain('userData.lifetimeSeconds')
        expect(read.error).toContain('positive whole number')
      }
    }
  )

  it('accepts the smallest positive whole lifetimeSeconds', () => {
    const read = readEphemeralVmLifetime({ releaseAt: RELEASE_AT, lifetimeSeconds: 1 })
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.lifetime?.lifetimeSeconds).toBe(1)
    }
  })

  it.each([
    ['provider', ''],
    ['provider', null],
    ['provider', {}],
    ['provider', Number.NaN],
    ['provider', Number.POSITIVE_INFINITY],
    ['resourceId', ''],
    ['resourceId', null],
    ['resourceId', []],
    ['resourceId', Number.NEGATIVE_INFINITY]
  ])('rejects the unusable %s value %j', (key, value) => {
    const read = readEphemeralVmLifetime({ releaseAt: RELEASE_AT, [key]: value })
    expect(read.ok).toBe(false)
    if (!read.ok) {
      expect(read.error).toBe(`userData.${key} must be a non-empty string or a finite number.`)
    }
  })

  it('normalizes numeric provider and resourceId identifiers to strings', () => {
    const read = readEphemeralVmLifetime({
      releaseAt: RELEASE_AT,
      provider: 42,
      resourceId: 0
    })
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.lifetime).toMatchObject({ provider: '42', resourceId: '0' })
    }
  })

  it('ignores unrelated userData keys', () => {
    const read = readEphemeralVmLifetime({
      releaseAt: RELEASE_AT,
      region: 'us-east-1',
      nested: { a: [1, 2, 3] },
      provider: 'aws'
    })
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.lifetime).not.toHaveProperty('region')
      expect(read.lifetime).not.toHaveProperty('nested')
    }
  })
})

describe('formatEphemeralVmRemaining', () => {
  it.each([
    [0, '0m'],
    [1, '0m'],
    [59_000, '0m'],
    [60_000, '1m'],
    [90_000, '1m'],
    [3_599_000, '59m'],
    [3_600_000, '1h'],
    [86_399_000, '23h'],
    [86_400_000, '1d'],
    [172_800_000, '2d']
  ])('formats %i ms as %s', (remainingMs, expected) => {
    expect(formatEphemeralVmRemaining(remainingMs)).toBe(expected)
  })

  it('floors rather than rounds up, so it never overstates the lease', () => {
    expect(formatEphemeralVmRemaining(119_999)).toBe('1m')
    expect(formatEphemeralVmRemaining(3_599_999)).toBe('59m')
    expect(formatEphemeralVmRemaining(86_399_999)).toBe('23h')
  })

  it.each([-1, -60_000, Number.NEGATIVE_INFINITY])(
    'never renders a negative label for %i ms',
    (remainingMs) => {
      expect(formatEphemeralVmRemaining(remainingMs)).toBe('0m')
    }
  )
})

describe('formatEphemeralVmCountdown', () => {
  it.each([
    [0, '00:00'],
    [1_000, '00:01'],
    [59_000, '00:59'],
    [60_000, '01:00'],
    [90_000, '01:30'],
    [3_599_000, '59:59'],
    [3_600_000, '1:00:00'],
    [86_399_000, '23:59:59'],
    [86_400_000, '24:00:00']
  ])('formats %i ms as %s', (remainingMs, expected) => {
    expect(formatEphemeralVmCountdown(remainingMs)).toBe(expected)
  })

  it('floors the seconds and never renders a negative countdown', () => {
    expect(formatEphemeralVmCountdown(1_999)).toBe('00:01')
    expect(formatEphemeralVmCountdown(-1)).toBe('00:00')
    expect(formatEphemeralVmCountdown(Number.NEGATIVE_INFINITY)).toBe('00:00')
  })
})

describe('getEphemeralVmRemainingMs and isEphemeralVmLifetimeExpired', () => {
  const lifetime: EphemeralVmLifetime = { releaseAt: RELEASE_AT, releaseAtMs: RELEASE_AT_MS }

  it.each([
    [RELEASE_AT_MS - 60_000, 60_000, false],
    [RELEASE_AT_MS - 1, 1, false],
    [RELEASE_AT_MS, 0, true],
    [RELEASE_AT_MS + 1, -1, true],
    [RELEASE_AT_MS + 60_000, -60_000, true]
  ])('at %i ms reports %i ms remaining and expired=%s', (nowMs, remainingMs, expired) => {
    expect(getEphemeralVmRemainingMs(lifetime, nowMs)).toBe(remainingMs)
    expect(isEphemeralVmLifetimeExpired(lifetime, nowMs)).toBe(expired)
  })

  it('treats the exact deadline as expired so nothing is offered past the lease', () => {
    expect(isEphemeralVmLifetimeExpired(lifetime, RELEASE_AT_MS)).toBe(true)
    expect(isEphemeralVmLifetimeExpired(lifetime, RELEASE_AT_MS - 1)).toBe(false)
  })
})
