import { expect, it } from 'vitest'
import {
  sessionSearchHistoryCutoffMs,
  sessionSearchRetentionWindowMs,
  usableRetentionCutoffMs
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

it('reports the window the cutoff implements, and none when unbounded', () => {
  expect(sessionSearchRetentionWindowMs(30)).toBe(30 * DAY)
  expect(sessionSearchRetentionWindowMs(0)).toBeNull()
  expect(sessionSearchRetentionWindowMs(null)).toBeNull()
})

it('keeps a cutoff at most a window past the newest indexed file', () => {
  const cutoff = sessionSearchHistoryCutoffMs(30, NOW) ?? 0
  const window = sessionSearchRetentionWindowMs(30)
  // One expired file and nothing else is a real state, so an ordinary purge has to survive it.
  expect(usableRetentionCutoffMs(cutoff, cutoff - 100, window)).toBe(cutoff)
  expect(usableRetentionCutoffMs(cutoff, cutoff, window)).toBe(cutoff)
  expect(usableRetentionCutoffMs(cutoff, cutoff - 30 * DAY, window)).toBe(cutoff)
})

it('ignores a cutoff that a clock jump pushed past the whole index', () => {
  const cutoff = sessionSearchHistoryCutoffMs(30, NOW + 400 * DAY) ?? 0
  expect(usableRetentionCutoffMs(cutoff, NOW, sessionSearchRetentionWindowMs(30))).toBeNull()
})

it('never clamps without a window or an index', () => {
  expect(usableRetentionCutoffMs(NOW, NOW - 100 * DAY, null)).toBe(NOW)
  expect(usableRetentionCutoffMs(NOW, NOW - 100 * DAY, 0)).toBe(NOW)
  expect(usableRetentionCutoffMs(null, NOW, 30 * DAY)).toBeNull()
  expect(usableRetentionCutoffMs(NOW, null, 30 * DAY)).toBe(NOW)
})
