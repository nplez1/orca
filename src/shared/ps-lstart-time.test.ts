import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePsStartTime, parseUtcLstart, psUtcEnvironment } from './ps-lstart-time'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ps lstart time', () => {
  // The hour a DST fall-back repeats: a local read returns this string an hour early, all year round.
  it('parses the repeated hour to the UTC instant', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    // Proves the guard bites on a UTC runner too: a local read here cannot yield this instant.
    expect(Date.parse('Sun Nov  1 01:37:04 2026')).not.toBe(Date.UTC(2026, 10, 1, 1, 37, 4))
    expect(parseUtcLstart('Sun Nov  1 01:37:04 2026')).toBe(Date.UTC(2026, 10, 1, 1, 37, 4))
    expect(parseUtcLstart('  Sun Nov  1 01:37:04 2026  ')).toBe(Date.UTC(2026, 10, 1, 1, 37, 4))
  })

  it('reads a start time in the shape it already names', () => {
    expect(parsePsStartTime('Sun Nov  1 01:37:04 2026')).toBe(Date.UTC(2026, 10, 1, 1, 37, 4))
    expect(parsePsStartTime('2026-11-01T01:37:04.000Z')).toBe(Date.UTC(2026, 10, 1, 1, 37, 4))
    // `Date.toString()` puts the name after the offset; appending `UTC` to it parses hours early.
    expect(parsePsStartTime('Sun Nov 01 2026 01:37:04 GMT-0800 (Pacific Standard Time)')).toBe(
      Date.UTC(2026, 10, 1, 9, 37, 4)
    )
  })

  it('asks ps for lstart in the zone the parser reads', () => {
    const env = psUtcEnvironment()

    expect(env.TZ).toBe('UTC')
    if (process.platform === 'darwin') {
      expect(env.LC_ALL).toBe('en_US.UTF-8')
    }
  })
})
