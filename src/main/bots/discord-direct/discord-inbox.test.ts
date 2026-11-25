import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claim, markHandled, park, releaseClaim, summary } from './discord-inbox'

let userDataPath: string
beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), 'orca-discord-inbox-'))
})
afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true })
})

describe('claiming a delivered message', () => {
  it('claims once, so a replay after a resume is dropped', async () => {
    expect(await claim(userDataPath, 'bot-1', 'm1')).toBe(true)
    expect(await claim(userDataPath, 'bot-1', 'm1')).toBe(false)

    await markHandled(userDataPath, 'bot-1', 'm1')
    expect(await claim(userDataPath, 'bot-1', 'm1')).toBe(false)
  })

  it('gives a claim back only while nothing has been done with the message', async () => {
    expect(await claim(userDataPath, 'bot-1', 'm1')).toBe(true)
    expect(await releaseClaim(userDataPath, 'bot-1', 'm1')).toBe(true)
    expect(await claim(userDataPath, 'bot-1', 'm1')).toBe(true)

    await markHandled(userDataPath, 'bot-1', 'm1')
    expect(await releaseClaim(userDataPath, 'bot-1', 'm1')).toBe(false)
    expect(await claim(userDataPath, 'bot-1', 'm1')).toBe(false)
  })

  it('keeps a parked message parked, and out of the way of a replay', async () => {
    expect(await claim(userDataPath, 'bot-1', 'm1')).toBe(true)
    const parked = await park(userDataPath, 'bot-1', 'm1', 'the chat was gone')

    expect(parked).toMatchObject({ messageId: 'm1', parkedReason: 'the chat was gone' })
    expect(await claim(userDataPath, 'bot-1', 'm1')).toBe(false)
    expect(await summary(userDataPath, 'bot-1')).toEqual({ parked: 1, undelivered: 0 })
  })

  it('counts what is parked and what is owed an answer', async () => {
    await claim(userDataPath, 'bot-1', 'm1')
    await claim(userDataPath, 'bot-1', 'm2')
    await markHandled(userDataPath, 'bot-1', 'm2')
    await claim(userDataPath, 'bot-1', 'm3')
    await park(userDataPath, 'bot-1', 'm3', 'too long to answer')

    expect(await summary(userDataPath, 'bot-1')).toEqual({ parked: 1, undelivered: 1 })
    expect(await summary(userDataPath, 'bot-2')).toEqual({ parked: 0, undelivered: 0 })
  })
})
