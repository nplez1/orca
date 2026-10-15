import { describe, expect, it } from 'vitest'
import { matchesCommandTerms } from './command-choice-filter'

describe('matchesCommandTerms', () => {
  it('matches every typed term anywhere in the searchable text', () => {
    expect(matchesCommandTerms('oct', ['October sprint', 'Future'])).toBe(true)
    expect(matchesCommandTerms('OCT', ['October sprint', 'Future'])).toBe(true)
    expect(matchesCommandTerms('sprint oct', ['October sprint', 'Future'])).toBe(true)
  })

  // Why this exists at all: cmdk's own scorer would accept scattered letters.
  it('does not match scattered letters', () => {
    expect(matchesCommandTerms('oct', ['Project cleanup', 'Future'])).toBe(false)
  })

  it('matches everything for an empty or blank search', () => {
    expect(matchesCommandTerms('', ['October sprint'])).toBe(true)
    expect(matchesCommandTerms('   ', ['October sprint'])).toBe(true)
  })

  it('requires every term, not any of them', () => {
    expect(matchesCommandTerms('october november', ['October sprint', 'Future'])).toBe(false)
  })
})
