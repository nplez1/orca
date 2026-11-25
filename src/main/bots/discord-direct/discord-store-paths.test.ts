import { describe, expect, it } from 'vitest'
import { discordPathSegment, discordPathSegmentId } from './discord-store-paths'

describe('a Discord id as a path segment', () => {
  it('refuses anything that could escape the directory it is joined into', () => {
    for (const id of ['..', '.', '', 'a/b', 'a\\b', '../escape', 'bot id', 'nul\u0000']) {
      expect(() => discordPathSegment(id)).toThrow(/not usable as a path segment/)
    }
  })

  it('accepts an ordinary id and a snowflake unchanged', () => {
    expect(discordPathSegment('orca-discord-bot')).toBe('orca-discord-bot')
    expect(discordPathSegment('1234567890123456789')).toBe('1234567890123456789')
    expect(discordPathSegment('9007199254740993')).toBe('9007199254740993')
  })

  it('encodes what a filesystem cannot carry, and decodes back to the id', () => {
    expect(discordPathSegment('a:b%c')).toBe('a%3Ab%25c')
    expect(discordPathSegmentId('a%3Ab%25c')).toBe('a:b%c')
    expect(() => discordPathSegment('a$b')).toThrow(/not usable as a path segment/)
  })
})
