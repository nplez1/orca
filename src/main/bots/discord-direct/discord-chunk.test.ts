import { describe, expect, it } from 'vitest'
import { chunkDiscordMessage } from './discord-chunk'
import { DISCORD_MAX_CHUNKS, DISCORD_MESSAGE_CONTENT_LIMIT } from './discord-contract'

const unpairedHighSurrogate = (chunk: string): boolean => {
  const last = chunk.charCodeAt(chunk.length - 1)
  return last >= 0xd800 && last <= 0xdbff
}

describe('chunkDiscordMessage', () => {
  it('keeps a message of exactly the limit in one chunk, and splits one unit more', () => {
    const exact = chunkDiscordMessage('a'.repeat(DISCORD_MESSAGE_CONTENT_LIMIT))
    expect(exact).toHaveLength(1)
    expect(exact[0]).toHaveLength(DISCORD_MESSAGE_CONTENT_LIMIT)

    const over = chunkDiscordMessage('a'.repeat(DISCORD_MESSAGE_CONTENT_LIMIT + 1))
    expect(over.map((chunk) => chunk.length)).toEqual([DISCORD_MESSAGE_CONTENT_LIMIT, 1])
  })

  it('never splits a surrogate pair at the cut', () => {
    const text = `${'a'.repeat(9)}😀`
    const chunks = chunkDiscordMessage(text, 10)
    expect(chunks.join('')).toBe(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10)
      expect(unpairedHighSurrogate(chunk)).toBe(false)
    }
  })

  it('closes an open fence at the cut and reopens it with its language tag', () => {
    const text = `\`\`\`ts\n${'x'.repeat(100)}\n\`\`\``
    const chunks = chunkDiscordMessage(text, 40)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40)
    }
    expect(chunks[0].startsWith('```ts\n')).toBe(true)
    expect(chunks[0].endsWith('\n```')).toBe(true)
    expect(chunks[1].startsWith('```ts\n')).toBe(true)
    expect(chunks.at(-1)?.endsWith('```')).toBe(true)
  })

  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunkDiscordMessage('')).toEqual([])
    expect(chunkDiscordMessage('   \n\n\t ')).toEqual([])
  })

  it('stops at one chunk past the message budget for text that is far too long', () => {
    const text = 'word '.repeat(5000)
    const chunks = chunkDiscordMessage(text)
    expect(chunks).toHaveLength(DISCORD_MAX_CHUNKS + 1)
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true)
  })
})
