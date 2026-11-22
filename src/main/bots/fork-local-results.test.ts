import { describe, expect, it, vi } from 'vitest'
import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import { BOT_QUIET_MARKER } from '../../shared/bot-quiet-result'
import { localAskAnswer, localAskAskers } from './fork-local-results'
import { makeTestBot } from './bot.test-fixture'

const FROM: AgentMessageSource = { kind: 'agent', senders: [], orchestration: null }
const LOCAL_OWNER: BotRequestAsker = {
  kind: 'person',
  source: 'local',
  userId: 'nathanp',
  name: 'nathanp',
  workspaceId: null,
  role: 'owner'
}

function result(resultsTo: 'chat' | 'none' | { channel: string }) {
  return {
    sessionId: 'session-1',
    automation: { id: 'auto-1', name: 'Morning digest', dtstart: 1 },
    bot: makeTestBot(),
    target: { runsIn: 'new' as const, resultsTo }
  }
}

function deps(localAsk: boolean) {
  return { localAskOf: () => localAsk, sendToChat: vi.fn(async () => undefined) }
}

describe('a local ask', () => {
  it('is a conversation whose asker is a person on this computer', () => {
    expect(localAskAskers([LOCAL_OWNER])).toBe(true)
    expect(localAskAskers([{ kind: 'owner' }])).toBe(false)
    expect(localAskAskers(undefined)).toBe(false)
  })

  it('gets its answer in the chat it was asked from, not in a cloud channel', async () => {
    const delivery = deps(true)

    const answered = await localAskAnswer(
      delivery,
      result({ channel: 'C123' }),
      'Two PRs merged overnight.',
      FROM
    )

    expect(answered).toEqual({})
    expect(delivery.sendToChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bot-1' }),
      expect.stringContaining('Two PRs merged overnight.'),
      FROM
    )
  })

  it('leaves a result that already lands there alone, and one nobody asked for', async () => {
    for (const [localAsk, resultsTo] of [
      [true, 'chat'],
      [true, 'none'],
      [false, { channel: 'C123' }]
    ] as const) {
      const delivery = deps(localAsk)
      expect(await localAskAnswer(delivery, result(resultsTo), 'Done.', FROM)).toBeNull()
      expect(delivery.sendToChat).not.toHaveBeenCalled()
    }
  })

  it('sends nothing when the turn had nothing to say', async () => {
    const delivery = deps(true)

    expect(
      await localAskAnswer(
        delivery,
        result({ channel: 'C123' }),
        `Nothing new.\n${BOT_QUIET_MARKER}`,
        FROM
      )
    ).toBeNull()
    expect(delivery.sendToChat).not.toHaveBeenCalled()
  })
})
