import { expect, it } from 'vitest'
import {
  CLOCK_JUMP_TOLERANCE_MS,
  isWallClockJump,
  sessionSearchHistoryCutoffMs
} from './session-search-retention-policy'

const NOW = 1_740_000_000_000
const DAY = 86_400_000

it('treats sub-day or non-positive counts as unbounded and caps large counts', () => {
  expect(sessionSearchHistoryCutoffMs(0.4, NOW)).toBeNull()
  expect(sessionSearchHistoryCutoffMs(0, NOW)).toBeNull()
  expect(sessionSearchHistoryCutoffMs(-30, NOW)).toBeNull()
  expect(sessionSearchHistoryCutoffMs(30, NOW)).toBe(NOW - 30 * DAY)
  expect(sessionSearchHistoryCutoffMs(999_999, NOW)).toBe(NOW - 3_650 * DAY)
})

it('moves the cutoff with the clock', () => {
  const later = NOW + DAY
  expect(sessionSearchHistoryCutoffMs(30, later)).toBe(
    (sessionSearchHistoryCutoffMs(30, NOW) ?? 0) + DAY
  )
})

it('calls a clock reading more than a week ahead of the previous one a jump', () => {
  expect(isWallClockJump(NOW, NOW + DAY)).toBe(false)
  expect(isWallClockJump(NOW, NOW + CLOCK_JUMP_TOLERANCE_MS)).toBe(false)
  expect(isWallClockJump(NOW, NOW + CLOCK_JUMP_TOLERANCE_MS + 1)).toBe(true)
  // A resumed VM or a wrong RTC lands decades away.
  expect(isWallClockJump(NOW, NOW + 400 * DAY)).toBe(true)
})

it('treats a first reading, and a clock that moved backwards, as believable', () => {
  expect(isWallClockJump(null, NOW)).toBe(false)
  expect(isWallClockJump(NOW, NOW - 400 * DAY)).toBe(false)
})
