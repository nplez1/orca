import { describe, expect, it, vi } from 'vitest'
import type { PhotonInboundMessage } from './photon-contract'
import {
  PhotonSpectrumChannel,
  spectrumInboundMessage,
  type SpectrumApp,
  type SpectrumMessage,
  type SpectrumSpace
} from './photon-spectrum-channel'

const space: SpectrumSpace = { id: 'space_1' }

const message = (over: Partial<SpectrumMessage> = {}): SpectrumMessage => ({
  id: 'msg_1',
  direction: 'inbound',
  sender: { id: '+15551230000' },
  content: { type: 'text', text: 'is the build green?' },
  timestamp: new Date(1_700_000_000_000),
  ...over
})

describe('a Spectrum message as the inbound handler’s shape', () => {
  it('maps an inbound text message onto the fields the inbox, the thread map and a reply need', () => {
    expect(spectrumInboundMessage(space, message())).toEqual({
      id: 'msg_1',
      conversationId: 'space_1',
      sender: { handle: '+15551230000' },
      text: 'is the build green?',
      createdAt: 1_700_000_000_000
    } satisfies PhotonInboundMessage)
  })

  it('reads a markdown message as its text, which is what the bot is asked', () => {
    const mapped = spectrumInboundMessage(
      space,
      message({ content: { type: 'markdown', markdown: '**deploy?**' } })
    )
    expect(mapped?.text).toBe('**deploy?**')
  })

  it('skips a message the bot itself sent, which Spectrum streams back to it', () => {
    expect(spectrumInboundMessage(space, message({ direction: 'outbound' }))).toBeNull()
  })

  it('skips anything the platform attributes to an agent, which is the bot talking to itself', () => {
    expect(
      spectrumInboundMessage(space, message({ sender: { id: 'bot_1', kind: 'agent' } }))
    ).toBeNull()
  })

  it('skips a message with no sender: there is nobody to attribute the ask to', () => {
    expect(spectrumInboundMessage(space, message({ sender: undefined }))).toBeNull()
  })

  it('skips a message with no text rather than opening a chat with no question in it', () => {
    expect(
      spectrumInboundMessage(space, message({ content: { type: 'attachment', text: '  ' } }))
    ).toBeNull()
    expect(spectrumInboundMessage(space, message({ content: { type: 'image' } }))).toBeNull()
  })
})

/** The SDK's own shape without the SDK: yields what it is given, then waits for `stop`. */
function fakeApp(messages: [SpectrumSpace, SpectrumMessage][]): {
  app: SpectrumApp
  sent: { conversationId: string; text: string }[]
} {
  const sent: { conversationId: string; text: string }[] = []
  let finish: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  return {
    sent,
    app: {
      messages: {
        async *[Symbol.asyncIterator](): AsyncIterableIterator<[SpectrumSpace, SpectrumMessage]> {
          for (const pair of messages) {
            yield pair
          }
          await finished
        }
      },
      async send(target, content) {
        sent.push({ conversationId: target.id, text: content })
      },
      async stop() {
        finish()
      }
    }
  }
}

describe('a Spectrum channel', () => {
  it('numbers what it hands over, skips the bot’s own message, and replies to the space it arrived in', async () => {
    const { app, sent } = fakeApp([
      [space, message()],
      [
        space,
        message({
          id: 'msg_2',
          direction: 'outbound',
          sender: { id: 'bot_1', kind: 'agent' },
          content: { type: 'text', text: 'on it' }
        })
      ],
      [
        { id: 'space_2' },
        message({
          id: 'msg_3',
          sender: { id: '+15557654321' },
          content: { type: 'text', text: 'and the deploy?' }
        })
      ]
    ])
    const delivered: { id: string; conversationId: string; seq: number }[] = []
    const channel = new PhotonSpectrumChannel({
      botId: 'b1',
      projectId: 'pho_prj_1',
      app,
      startSeq: 41,
      onMessage: async (inbound, seq) => {
        delivered.push({
          id: inbound.id,
          conversationId: inbound.conversationId,
          seq
        })
      },
      log: () => {}
    })

    channel.start()
    await vi.waitFor(() => expect(delivered).toHaveLength(2))
    expect(delivered).toEqual([
      { id: 'msg_1', conversationId: 'space_1', seq: 42 },
      { id: 'msg_3', conversationId: 'space_2', seq: 43 }
    ])

    await channel.send('space_2', 'the deploy is green')
    expect(sent).toEqual([{ conversationId: 'space_2', text: 'the deploy is green' }])
    channel.stop()
  })

  it('refuses a reply to a conversation this run never received, rather than inventing a space', async () => {
    const { app } = fakeApp([])
    const channel = new PhotonSpectrumChannel({
      botId: 'b1',
      projectId: 'pho_prj_1',
      app,
      startSeq: 0,
      onMessage: async () => {},
      log: () => {}
    })

    await expect(channel.send('space_9', 'hello')).rejects.toThrow(/no live Spectrum space/)
  })
})

describe('a reply to a conversation this run never received', () => {
  /** The SDK's lookup by id, as spectrum-ts 12.16.0 offers it through the provider namespace. */
  function appWithLookup(lookup: (id: string) => Promise<SpectrumSpace>) {
    const sent: { conversationId: string; text: string }[] = []
    const app: SpectrumApp = {
      messages: fakeApp([]).app.messages,
      async send(space, content) {
        sent.push({ conversationId: space.id, text: content })
      },
      space: lookup,
      async stop() {}
    }
    return { app, sent }
  }

  it('resolves the space from the SDK instead of refusing, which is what a replay after a restart needs', async () => {
    // The inbox replayed an answer for a message from the previous run, so no space has been streamed
    // here: the id in the thread map is all there is.
    const { app, sent } = appWithLookup(async (id) => ({ id }))
    const channel = new PhotonSpectrumChannel({
      botId: 'b1',
      projectId: 'pho_prj_1',
      app,
      startSeq: 0,
      onMessage: async () => {},
      log: () => {}
    })

    await channel.send('space_replayed', 'the build is green')

    expect(sent).toEqual([{ conversationId: 'space_replayed', text: 'the build is green' }])
  })

  it('keeps the honest refusal when the SDK cannot resolve the id', async () => {
    const { app } = appWithLookup(async () => {
      throw new Error('no such space')
    })
    const channel = new PhotonSpectrumChannel({
      botId: 'b1',
      projectId: 'pho_prj_1',
      app,
      startSeq: 0,
      onMessage: async () => {},
      log: () => {}
    })

    await expect(channel.send('space_gone', 'hello')).rejects.toThrow(/no live Spectrum space/)
  })
})
