import { normalizeAiVaultSearchHistoryDays } from '../../shared/ai-vault-search-settings'

const DAY_MS = 86_400_000

/** The oldest transcript mtime worth indexing; null means no bound. */
export function sessionSearchHistoryCutoffMs(
  historyDays: number | null,
  nowMs: number
): number | null {
  const days = normalizeAiVaultSearchHistoryDays(historyDays)
  return days === null ? null : nowMs - days * DAY_MS
}

/** The retention window length the cutoff implements; null when the setting means "unbounded". */
export function sessionSearchRetentionWindowMs(historyDays: number | null): number | null {
  const days = normalizeAiVaultSearchHistoryDays(historyDays)
  return days === null ? null : days * DAY_MS
}

/**
 * A cutoff that a jumped clock pushed more than a window past the newest indexed file would purge the
 * whole index, and nothing re-indexes those rows until the clock is right again.
 *
 * Why a window of slack rather than any overshoot: files are indexed while they are inside the
 * window, so an ordinary purge sits at most about one window above the newest row — one expired file
 * and nothing else is a real state, and it must still be deleted. A wrong RTC or a resumed VM moves
 * `now` by days or years, which is what the extra window distinguishes. A null window means no bound,
 * so nothing is clamped.
 */
export function usableRetentionCutoffMs(
  cutoffMs: number | null,
  newestIndexedMtimeMs: number | null,
  windowMs: number | null
): number | null {
  if (cutoffMs === null || newestIndexedMtimeMs === null || windowMs === null || windowMs <= 0) {
    return cutoffMs
  }
  return cutoffMs - newestIndexedMtimeMs > windowMs ? null : cutoffMs
}
