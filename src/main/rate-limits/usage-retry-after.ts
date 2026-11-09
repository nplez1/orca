import { parseRetryAfterHeaderMs } from '../../shared/retry-after-header'

// Cap corrupt/hostile headers so they cannot suppress polling indefinitely.
const MAX_USAGE_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

export function parseUsageRetryAfterMs(value: string | null, nowMs?: number): number | null {
  return parseRetryAfterHeaderMs(value, MAX_USAGE_RETRY_AFTER_MS, nowMs)
}

/** The same ceiling for a wait a caller parsed itself, e.g. out of a CLI's error text. */
export function capUsageRetryAfterMs(retryAfterMs: number | null): number | null {
  return retryAfterMs === null
    ? null
    : Math.min(Math.max(0, retryAfterMs), MAX_USAGE_RETRY_AFTER_MS)
}
