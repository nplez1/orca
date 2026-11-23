// What happens after the crash the inbox exists for: replaying what Orca wrote down and never dealt with,
// holding a paused bot's mail, and refusing to ack a follow-up that was never delivered.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PhotonInboundMessage } from './photon-contract'
import { inboundHarness } from './photon-inbound.test-harness'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-photon-recovery-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

const harness = (options: Parameters<typeof inboundHarness>[1] = {}) =>
  inboundHarness(userDataPath, options)

const message = (over: Partial<PhotonInboundMessage> = {}): PhotonInboundMessage => ({
  id: 'msg_1',
  conversationId: 'conv_1',
  sender: { handle: '+15551230000', name: 'Sam' },
  text: 'is the build green?',
  createdAt: 1000,
  ...over
})

describe('what the recovery replays', () => {
  it('dispatches what Orca wrote down and never dealt with, oldest stream position first', async () => {
    // Both writes landed; neither turn started, and Photon never redelivers them.
    const crashed = harness({ failStart: true })
    await expect(
      crashed.inbound.handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
    ).rejects.toThrow()

    const restarted = harness()
    const outcomes = await restarted.inbound.recover({ botId: 'b1', projectId: 'p1' })

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['ran'])
    expect(restarted.calls.map((call) => call.text)).toEqual(['is the build green?'])
    expect(restarted.cursors.read('p1')).toBe(41)
  })

  it('replays nothing when everything was handled', async () => {
    const test = harness()
    await test.inbound.handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
    expect(await test.inbound.recover({ botId: 'b1', projectId: 'p1' })).toEqual([])
    expect(test.calls).toHaveLength(1)
  })
})

describe('a paused bot', () => {
  it('holds its message instead of starting a turn, and replays it on resume', async () => {
    const paused = harness({ paused: true })
    const held = await paused.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message()
    })

    expect(held).toEqual({ kind: 'held', messageId: 'msg_1' })
    expect(paused.calls).toEqual([])
    // Held, not dropped: no handledAt and no cursor move, so the resume replays it.
    expect(paused.cursors.read('p1')).toBe(0)
    expect(paused.inbox.unhandled('p1')).toHaveLength(1)

    const resumed = harness()
    const outcomes = await resumed.inbound.recover({ botId: 'b1', projectId: 'p1' })
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['ran'])
    expect(resumed.calls).toHaveLength(1)
  })
})

describe('a refused follow-up', () => {
  it('is not marked handled and does not advance the cursor, so it is not lost', async () => {
    const test = harness({ refusedSend: 'This chat is closed.' })
    await test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message({ id: 'msg_41', conversationId: 'conv_1' })
    })
    // Pin the conversation to a chat so the second message takes the follow-up path.
    test.threads.bind('b1', 'conv_2', { chatId: 'chat_1', handle: '+15551230000' })

    await expect(
      test.inbound.handle({
        botId: 'b1',
        projectId: 'p1',
        seq: 47,
        message: message({ id: 'msg_47', conversationId: 'conv_2', text: 'any news?' })
      })
    ).rejects.toThrow('This chat is closed.')

    // The refusal is not a delivery: the message stays unhandled for the recovery, not silently acked.
    expect(test.inbox.read('p1', 'msg_47')?.handledAt).toBeUndefined()
    expect(test.cursors.read('p1')).toBe(41)
    expect(test.inbox.unhandled('p1').map((entry) => entry.messageId)).toEqual(['msg_47'])
  })
})
