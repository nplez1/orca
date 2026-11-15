import { asRecord } from './session-record-fields'

/** ECMAScript Date range; `new Date(ms).toISOString()` throws beyond it. */
const MAX_DATE_MS = 8_640_000_000_000_000
/** Beyond this the value is a mis-scaled epoch or a broken clock, never a session time. */
const FUTURE_TIMESTAMP_SKEW_MS = 24 * 60 * 60 * 1000

/**
 * One timestamp from a transcript written by somebody else's agent.
 *
 * Why the bounds: a nanosecond epoch is ordinary format drift, and `new Date(1.7e18)` throws
 * `RangeError` inside the parse loop, which loses the whole session rather than one line. A
 * microsecond epoch is inside the Date range but lands in the year 55840, so it would pin its row
 * above every real session forever.
 *
 * Why an impossible value is dropped rather than clamped to now: the row would still sort to the
 * top, and the same line would decode to a different instant on every read. Dropped, the other
 * timestamps in the transcript — or the file's own mtime — decide the order. Numbers only: an ISO
 * string states which instant it means, and extended-year values like `+010000-01-01` are preserved.
 */
export function timestampMs(value: unknown): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Number.NaN
  }
  const parsed = value > 1_000_000_000_000 ? value : value * 1000
  if (parsed > MAX_DATE_MS || parsed > Date.now() + FUTURE_TIMESTAMP_SKEW_MS) {
    return Number.NaN
  }
  return parsed
}

export function timeObjectValue(value: unknown, key: string): string | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const rawValue = record[key]
  if (typeof rawValue === 'string') {
    return rawValue
  }
  const parsed = timestampMs(rawValue)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return new Date(parsed).toISOString()
}
