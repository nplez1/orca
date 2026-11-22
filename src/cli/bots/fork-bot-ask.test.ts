import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { askSubject, BOT_ASK_HANDLERS, botAskChat, botOfSelector } from './fork-bot-ask'

const { resolveActive } = vi.hoisted(() => ({ resolveActive: vi.fn() }))
// The resolver that infers a terminal from the working folder: the ask must never reach it.
vi.mock('../orchestration/identity/terminal-identity', () => ({
  resolveOrchestrationTerminalHandle: resolveActive
}))

const SCOUT = { id: 'bot-1', name: 'Scout' }
const DOCS = { id: 'bot-2', name: 'Docs' }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

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
  chats: BotChatRow[] = [chatRow()],
  terminal = 'term_ask'
): Promise<{ method: string; params: unknown }[]> {
  if (terminal) {
    vi.stubEnv('ORCA_TERMINAL_HANDLE', terminal)
  } else {
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
  }
  resolveActive.mockReset()
  resolveActive.mockResolvedValue('term_inferred')
  const calls: { method: string; params: unknown }[] = []
  const call = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params })
    if (!['bots.list', 'bots.chats', 'orchestration.send'].includes(method)) {
      // A shell outside Orca: nothing answers for a terminal, which is the case under test.
      throw new RuntimeClientError('no_active_sender_terminal', 'no terminal here')
    }
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

const refusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (error) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RuntimeClientError carries its code as a string field.
    return (error as { code?: string }).code ?? 'no code'
  }
  throw new Error('expected a refusal')
}

describe('bot ask', () => {
  it('sends the ask to the bot by id, as a question, in the Home Chat when no chat is named', async () => {
    const calls = await ask([
      ['bot', 'Scout'],
      ['body', 'how is the release going?']
    ])

    expect(sent(calls)).toEqual([
      {
        method: 'orchestration.send',
        params: expect.objectContaining({
          to: 'bot:bot-1',
          body: 'how is the release going?',
          type: 'question',
          // So the answer has somewhere to go, and the command can say where.
          from: 'term_inferred'
        })
      }
    ])
    expect(sent(calls)[0]!.params).not.toHaveProperty('chat')
  })

  it('sends no from from a shell Orca did not start, even when a pane could be inferred', async () => {
    const calls = await ask(
      [
        ['bot', 'Scout'],
        ['body', 'hello']
      ],
      [chatRow()],
      ''
    )

    // Another pane's handle would take its mail and type the answer into its agent.
    expect(resolveActive).not.toHaveBeenCalled()
    expect(sent(calls)).toHaveLength(1)
    expect(sent(calls)[0]!.params).not.toHaveProperty('from')
  })

  it('re-mints a stale handle rather than using it', async () => {
    const calls = await ask([
      ['bot', 'Scout'],
      ['body', 'hello']
    ])

    expect(resolveActive).toHaveBeenCalledWith(expect.anything(), '/', expect.anything(), 'from', {
      validateEnvHandle: true
    })
    expect(sent(calls)[0]!.params).toMatchObject({ from: 'term_inferred' })
  })

  it('forwards the chat that takes mail, named by id', async () => {
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
      to: 'bot:bot-2',
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

  it('sends nothing to a bot no name or id matches', async () => {
    expect(
      await refusal(() =>
        ask([
          ['bot', 'Nobody'],
          ['body', 'hello']
        ])
      )
    ).toBe('bot_not_found')
  })

  it('refuses a name two bots answer to instead of picking one', () => {
    expect(() => botOfSelector([SCOUT, { id: 'bot-3', name: 'scout' }], 'Scout')).toThrow()
    expect(botOfSelector([SCOUT, DOCS], 'scout')).toBe(SCOUT)
  })

  it('refuses a chat this bot does not have, and one that takes no mail now', async () => {
    const missing = await refusal(() =>
      ask([
        ['bot', 'Scout'],
        ['chat', 'chat:gone'],
        ['body', 'hello']
      ])
    )
    expect(missing).toBe('chat_not_found')

    const closed = await refusal(() =>
      ask(
        [
          ['bot', 'Scout'],
          ['chat', 'chat:home'],
          ['body', 'hello']
        ],
        [chatRow({ closed: true, reason: 'ended' })]
      )
    )
    expect(closed).toBe('chat_closed')
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
