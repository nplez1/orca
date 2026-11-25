import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  advanceHandled,
  allConversations,
  bindChannel,
  findByChannel,
  unbindChat
} from './discord-thread-map'

let userDataPath: string
beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), 'orca-discord-threads-'))
})
afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true })
})

describe('one channel is one bot chat', () => {
  it('updates the entry a second bind names rather than making a second chat', async () => {
    const first = await bindChannel(userDataPath, 'bot-1', {
      chatId: 'chat-a',
      kind: 'dm',
      channelId: 'chan-1',
      openerUserId: 'user-1'
    })
    const second = await bindChannel(userDataPath, 'bot-1', {
      chatId: 'chat-b',
      kind: 'thread',
      guildId: 'guild-1',
      channelId: 'chan-1',
      openerUserId: 'user-1'
    })

    const conversations = await allConversations(userDataPath, 'bot-1')
    expect(conversations).toHaveLength(1)
    expect(conversations[0]?.chatId).toBe('chat-b')
    expect(conversations[0]?.kind).toBe('thread')
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    expect(await findByChannel(userDataPath, 'bot-1', 'chan-1')).toEqual(second)
  })

  it('never moves the handled mark backwards, and not even onto the same message', async () => {
    await bindChannel(userDataPath, 'bot-1', {
      chatId: 'chat-a',
      kind: 'dm',
      channelId: 'chan-1',
      openerUserId: 'user-1',
      lastHandledMessageId: '100'
    })

    expect(await advanceHandled(userDataPath, 'bot-1', 'chan-1', '50')).toBe(false)
    expect(await advanceHandled(userDataPath, 'bot-1', 'chan-1', '100')).toBe(false)
    expect((await findByChannel(userDataPath, 'bot-1', 'chan-1'))?.lastHandledMessageId).toBe('100')

    expect(await advanceHandled(userDataPath, 'bot-1', 'chan-1', '150')).toBe(true)
    expect((await findByChannel(userDataPath, 'bot-1', 'chan-1'))?.lastHandledMessageId).toBe('150')
  })

  it('compares snowflakes above 2^53 as BigInt, where Number would call them equal', async () => {
    await bindChannel(userDataPath, 'bot-1', {
      chatId: 'chat-a',
      kind: 'inline',
      guildId: 'guild-1',
      channelId: 'chan-1',
      openerUserId: 'user-1',
      lastHandledMessageId: '9007199254740992'
    })

    // The wrong comparison, spelled out: these are one apart and Number cannot tell them apart.
    expect(Number('9007199254740993') === Number('9007199254740992')).toBe(true)

    expect(await advanceHandled(userDataPath, 'bot-1', 'chan-1', '9007199254740993')).toBe(true)
    expect((await findByChannel(userDataPath, 'bot-1', 'chan-1'))?.lastHandledMessageId).toBe(
      '9007199254740993'
    )
    expect(await advanceHandled(userDataPath, 'bot-1', 'chan-1', '9007199254740992')).toBe(false)
  })

  it('answers nothing for a channel it has never seen, and unbinds by chat', async () => {
    expect(await findByChannel(userDataPath, 'bot-1', 'chan-1')).toBeNull()
    expect(await advanceHandled(userDataPath, 'bot-1', 'chan-1', '10')).toBe(false)

    await bindChannel(userDataPath, 'bot-1', {
      chatId: 'chat-a',
      kind: 'dm',
      channelId: 'chan-1',
      openerUserId: 'user-1'
    })

    expect(await unbindChat(userDataPath, 'bot-1', 'chat-a')).toBe(true)
    expect(await unbindChat(userDataPath, 'bot-1', 'chat-a')).toBe(false)
    expect(await allConversations(userDataPath, 'bot-1')).toEqual([])
  })
})
