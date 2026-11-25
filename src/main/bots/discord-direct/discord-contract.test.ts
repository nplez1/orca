import { describe, expect, it } from 'vitest'
import {
  DISCORD_CLOSE_CODES,
  DISCORD_DEFAULT_INTENTS,
  DISCORD_INTENTS,
  discordCloseDecision
} from './discord-contract'

describe('discordCloseDecision', () => {
  it('decides every close code the table lists', () => {
    const stop = [4004, 4010, 4011, 4012, 4013, 4014]
    const identify = [4007, 4009]
    for (const code of Object.keys(DISCORD_CLOSE_CODES).map(Number)) {
      const expected = stop.includes(code)
        ? 'stop'
        : identify.includes(code)
          ? 'identify'
          : 'resume'
      expect(discordCloseDecision(code)).toBe(expected)
    }
    const reconnectable = Object.entries(DISCORD_CLOSE_CODES)
      .filter(([, entry]) => entry.reconnect)
      .map(([code]) => Number(code))
    expect(reconnectable.filter((code) => stop.includes(code))).toEqual([])
  })

  it('names the codes the docs single out', () => {
    expect(discordCloseDecision(4004)).toBe('stop')
    expect(discordCloseDecision(4000)).toBe('resume')
    expect(discordCloseDecision(4009)).toBe('identify')
    expect(discordCloseDecision(4013)).toBe('stop')
    expect(discordCloseDecision(4014)).toBe('stop')
  })

  it('resumes a code the table does not list', () => {
    expect(discordCloseDecision(1006)).toBe('resume')
  })
})

describe('DISCORD_DEFAULT_INTENTS', () => {
  it('is the OR of the three intents, at their documented bit positions', () => {
    expect(DISCORD_INTENTS.GUILDS).toBe(1)
    expect(DISCORD_INTENTS.GUILD_MESSAGES).toBe(512)
    expect(DISCORD_INTENTS.DIRECT_MESSAGES).toBe(4096)
    expect(DISCORD_DEFAULT_INTENTS).toBe(
      DISCORD_INTENTS.GUILDS | DISCORD_INTENTS.GUILD_MESSAGES | DISCORD_INTENTS.DIRECT_MESSAGES
    )
    expect(DISCORD_DEFAULT_INTENTS).toBe(4609)
  })
})
