import { describe, expect, it, vi } from 'vitest'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import type { RuntimeClient } from '../runtime/client'
import { askSubject, BOT_ASK_HANDLERS, botAskChat, botOfSelector } from './bot-ask'

const SCOUT = { id: 'bot-1', name: 'Scout' }
const DOCS = { id: 'bot-2', name: 'Docs' }

function chatRow(overrides: Partial<BotChatRow> = {}): BotChatRow {
  return {
    id: 'chat:home',
    title: 'Home',
    lastActivityAt: 1,
    lastAsked: null,
    lastSaid: null,
    home: true,
    self: false,
    closed: false,
    ...overrides
  }
}

async function ask(
  flags: [string, string | boolean][],
  chats: BotChatRow[] = [chatRow()]
): Promise<{ method: string; params: unknown }[]> {
  const calls: { method: string; params: unknown }[] = []
  const call = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params })
    const result =
      method === 'bots.list'
        ? { bots: [SCOUT, DOCS] }
        : method === 'bots.chats'
          ? { bot: SCOUT.name, chats }
          : { message: { id: 'msg-1' } }
    return { id: 'r', ok: true as const, result, _meta: { runtimeId: 'rt' } }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only client.call.
  const client = { call } as unknown as RuntimeClient
  await BOT_ASK_HANDLERS['bot ask']!({
    flags: new Map<string, string | boolean>(flags),
    client,
    cwd: '/',
    json: false
  })
  return calls
}

const sent = (calls: { method: string; params: unknown }[]) =>
  calls.filter((entry) => entry.method === 'orchestration.send')

describe('bot ask', () => {
  it('sends the ask to the bot as a question, in the Home Chat when no chat is named', async () => {
    const calls = await ask([
      ['bot', 'Scout'],
      ['body', 'how is the release going?']
    ])

    expect(sent(calls)).toEqual([
      {
        method: 'orchestration.send',
        params: expect.objectContaining({
          to: 'bot:Scout',
          body: 'how is the release going?',
          type: 'question'
        })
      }
    ])
    expect(sent(calls)[0]!.params).not.toHaveProperty('chat')
  })

  it('names the bot by id, in any case, and forwards the chat that takes mail', async () => {
    const calls = await ask(
      [
        ['bot', 'bot-2'],
        ['chat', 'chat:work'],
        ['body', 'status?'],
        ['subject', 'Release']
      ],
      [chatRow({ id: 'chat:work', title: 'Work', home: false })]
    )

    expect(sent(calls)[0]!.params).toMatchObject({
      to: 'bot:Docs',
      chat: 'chat:work',
      subject: 'Release'
    })
  })

  it('starts a chat of its own for --chat new, without looking one up', async () => {
    const calls = await ask([
      ['bot', 'Scout'],
      ['chat', 'new'],
      ['body', 'hello']
    ])

    expect(calls.some((entry) => entry.method === 'bots.chats')).toBe(false)
    expect(sent(calls)[0]!.params).toMatchObject({ chat: 'new' })
  })

  it('refuses a bot no name or id matches, naming the bots there are', async () => {
    await expect(
      ask([
        ['bot', 'Nobody'],
        ['body', 'hello']
      ])
    ).rejects.toThrow(/Scout, Docs/)
  })

  it('refuses a name two bots answer to instead of picking one', () => {
    expect(() => botOfSelector([SCOUT, { id: 'bot-3', name: 'scout' }], 'Scout')).toThrow(
      /both answer to Scout/
    )
  })

  it('refuses a chat this bot does not have, and one that takes no mail now', () => {
    expect(() => botAskChat('chat:gone', [chatRow()])).toThrow(/no chat chat:gone/)
    expect(() => botAskChat('chat:home', [chatRow({ closed: true, reason: 'ended' })])).toThrow(
      /takes no mail now \(ended\)/
    )
    expect(botAskChat(undefined, [])).toBeUndefined()
  })

  it("takes the ask's first line as its subject, and says when there is none", () => {
    expect(askSubject('how is the release going?\nand the review?', undefined)).toBe(
      'how is the release going?'
    )
    expect(askSubject('  \n\nsecond line', undefined)).toBe('second line')
    expect(askSubject('x'.repeat(200), undefined).length).toBeLessThanOrEqual(80)
    expect(askSubject('', undefined)).toBeTruthy()
    expect(askSubject('body', ' Given ')).toBe('Given')
  })
})
