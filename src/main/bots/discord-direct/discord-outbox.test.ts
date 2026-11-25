import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { complete, drop, enqueue, markPartSent, nextPending, nonceFor } from './discord-outbox'

let userDataPath: string
beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), 'orca-discord-outbox-'))
})
afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true })
})

const reply = (entryId: string, parts: string[]) => ({
  entryId,
  botId: 'bot-1',
  channelId: 'chan-1',
  parts
})

describe('a reply that is several messages', () => {
  it('resumes at the part it stopped on, and never resends the first', async () => {
    const queued = await enqueue(userDataPath, reply('e1', ['first', 'second', 'third']))
    expect(queued.sentParts).toBe(0)

    const started = await nextPending(userDataPath, 'bot-1')
    expect(started?.parts.slice(started.sentParts)).toEqual(['first', 'second', 'third'])

    await markPartSent(userDataPath, 'e1', 0)

    const resumed = await nextPending(userDataPath, 'bot-1')
    expect(resumed?.sentParts).toBe(1)
    expect(resumed?.parts.slice(resumed.sentParts)).toEqual(['second', 'third'])

    await markPartSent(userDataPath, 'e1', 1)
    await markPartSent(userDataPath, 'e1', 2)
    expect(await nextPending(userDataPath, 'bot-1')).toBeNull()

    await complete(userDataPath, 'e1')
    expect(await nextPending(userDataPath, 'bot-1')).toBeNull()
  })

  it('never rewinds the count when a part is acknowledged twice', async () => {
    await enqueue(userDataPath, reply('e1', ['first', 'second']))
    await markPartSent(userDataPath, 'e1', 1)

    expect((await markPartSent(userDataPath, 'e1', 0))?.sentParts).toBe(2)
    expect(await nextPending(userDataPath, 'bot-1')).toBeNull()
  })

  it('keeps the count when the same reply is enqueued again by a replay', async () => {
    await enqueue(userDataPath, reply('e1', ['first', 'second']))
    await markPartSent(userDataPath, 'e1', 0)

    const again = await enqueue(userDataPath, reply('e1', ['first', 'second']))

    expect(again.sentParts).toBe(1)
    expect(await nextPending(userDataPath, 'bot-1')).toMatchObject({ sentParts: 1 })
  })

  it('hands back what it gave up on, and stops retrying it', async () => {
    await enqueue(userDataPath, reply('e1', ['first', 'second']))
    await markPartSent(userDataPath, 'e1', 0)

    expect(await drop(userDataPath, 'e1', 'channel deleted')).toMatchObject({
      entryId: 'e1',
      sentParts: 1
    })
    expect(await nextPending(userDataPath, 'bot-1')).toBeNull()
    expect(await drop(userDataPath, 'e1', 'channel deleted')).toBeNull()
  })
})

describe('the nonce Discord dedupes against', () => {
  it('is stable across calls, distinct per part, and fits the 25-character cap', () => {
    const first = nonceFor('entry-1', 0)

    expect(nonceFor('entry-1', 0)).toBe(first)
    expect(nonceFor('entry-1', 1)).not.toBe(first)
    expect(nonceFor('entry-2', 0)).not.toBe(first)
    expect(first).toMatch(/^[0-9a-f]{16}:0$/)
    expect(first.length).toBeLessThanOrEqual(25)
  })

  it('is the base the stored entry records', async () => {
    const queued = await enqueue(userDataPath, reply('e1', ['only']))

    expect(queued.nonceFor).toBe(nonceFor('e1', 0).split(':')[0])
  })
})
