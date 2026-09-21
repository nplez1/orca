import { describe, expect, it } from 'vitest'
import { selectChecksCacheEntry } from './checks-cache-entry-selection'

const entry = (fetchedAt: number, headSha?: string) => ({
  data: [],
  fetchedAt,
  ...(headSha ? { headSha } : {})
})

describe('selectChecksCacheEntry', () => {
  it('prefers the head-sha keyed entry that fetchPRChecks writes', () => {
    const selected = selectChecksCacheEntry(
      { withHead: entry(200, 'new-head'), legacy: entry(100) },
      'withHead',
      'legacy'
    )

    expect(selected?.fetchedAt).toBe(200)
  })

  it('falls back to the legacy head-less entry when the head-sha key is absent', () => {
    const selected = selectChecksCacheEntry({ legacy: entry(100) }, 'withHead', 'legacy')

    expect(selected?.fetchedAt).toBe(100)
  })

  it('returns undefined when neither key is cached', () => {
    expect(selectChecksCacheEntry({}, 'withHead', 'legacy')).toBeUndefined()
  })
})
