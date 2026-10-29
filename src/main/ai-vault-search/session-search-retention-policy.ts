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

/**
 * How far a wall clock may move within one process before the reading is not a clock.
 *
 * Why a week of slack: a suspended laptop legitimately wakes with a week of elapsed time, while a
 * wrong RTC or a resumed VM lands decades away. Nothing below the threshold is treated as a jump.
 */
export const CLOCK_JUMP_TOLERANCE_MS = 7 * DAY_MS

/**
 * Whether this reading is a clock jump rather than elapsed time.
 *
 * Why the reading itself and not the index: a jumped clock writes *new* rows at the jumped time, so any
 * test of "the cutoff is past the newest indexed file" stops applying the moment the user does
 * anything. Comparing two readings of the same clock is not defeated by activity, and needs no stored
 * state: `lastNowMs` is the previous pass's reading in this process.
 */
export function isWallClockJump(lastNowMs: number | null, nowMs: number): boolean {
  return lastNowMs !== null && nowMs - lastNowMs > CLOCK_JUMP_TOLERANCE_MS
}
