import { describe, expect, it } from 'vitest'
import {
  PhotonReplyRefusal,
  postPhotonReply,
  type PhotonReplyChannel
} from './photon-connector-reply'
import type { PhotonSendOutcome } from './photon-send'

const base = { botId: 'b1', chatId: 'chat-1', text: 'done: #12 merged', replyId: 'r-42' }

type Sent = { conversationId: string; text: string; turnId: string }

function fakeChannel(options: {
  conversationId?: string | null
  outcome?: PhotonSendOutcome
}): PhotonReplyChannel & { sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    conversationForChat: async () =>
      'conversationId' in options ? (options.conversationId ?? null) : 'conv-1',
    sendTurnResult: async (input) => {
      sent.push({ conversationId: input.conversationId, text: input.text, turnId: input.turnId })
      return options.outcome ?? { sent: true, entryId: 'e1', truncated: false }
    }
  }
}

describe('postPhotonReply', () => {
  it('posts into the conversation this chat answers, keyed on the reply id', async () => {
    const channel = fakeChannel({})
    expect(await postPhotonReply(channel, base)).toEqual({
      status: 'posted',
      place: 'the iMessage conversation'
    })
    expect(channel.sent).toEqual([
      { conversationId: 'conv-1', text: 'done: #12 merged', turnId: 'r-42' }
    ])
  })

  it('reports a send the channel could not make yet as queued, not as sent', async () => {
    const channel = fakeChannel({
      outcome: { sent: false, entryId: 'e1', error: 'socket down' }
    })
    const result = await postPhotonReply(channel, base)
    expect(result?.status).toBe('queued')
    expect(result?.notices?.[0]).toContain('socket down')
  })

  it('falls through when this chat is not one the channel opened', async () => {
    const channel = fakeChannel({ conversationId: null })
    expect(await postPhotonReply(channel, base)).toBeNull()
    expect(channel.sent).toEqual([])
  })

  it('falls through when no channel is built at all', async () => {
    expect(await postPhotonReply(null, base)).toBeNull()
  })

  it('refuses a review rather than posting its prose as if the verdict landed', async () => {
    const channel = fakeChannel({})
    let refusal: unknown = null
    try {
      await postPhotonReply(channel, { ...base, review: { verdict: 'approve' } })
    } catch (error: unknown) {
      refusal = error
    }
    if (!(refusal instanceof PhotonReplyRefusal)) {
      throw new Error(`expected a PhotonReplyRefusal, got ${String(refusal)}`)
    }
    expect(refusal.code).toBe('no_review_on_imessage')
    expect(channel.sent).toEqual([])
  })
})
