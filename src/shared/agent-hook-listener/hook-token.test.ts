import { describe, expect, it } from 'vitest'
import { hookTokenMatches } from './hook-token'

const TOKEN = '4d1f0a3e-6a1b-4c62-9d38-8e0a2f5b7c11'

describe('hook token comparison', () => {
  it('accepts only the exact token', () => {
    expect(hookTokenMatches(TOKEN, TOKEN)).toBe(true)
  })

  it('rejects a token that differs in its last byte, not just in length', () => {
    const flipped = `${TOKEN.slice(0, -1)}${TOKEN.endsWith('1') ? '2' : '1'}`
    expect(flipped).toHaveLength(TOKEN.length)
    expect(hookTokenMatches(flipped, TOKEN)).toBe(false)
  })

  // Why: timingSafeEqual throws on a length mismatch, so the length guard is what keeps a short guess
  // an ordinary 403 instead of a failed request.
  it('rejects a prefix without throwing', () => {
    expect(hookTokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false)
    expect(hookTokenMatches('', TOKEN)).toBe(false)
  })

  it('rejects a missing, repeated, or non-string header', () => {
    expect(hookTokenMatches(undefined, TOKEN)).toBe(false)
    expect(hookTokenMatches([TOKEN], TOKEN)).toBe(false)
    expect(hookTokenMatches(TOKEN, '')).toBe(false)
  })
})
