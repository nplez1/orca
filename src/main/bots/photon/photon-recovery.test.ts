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
    expect(await restarted.cursors.read('p1')).toBe(41)
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
    expect(await paused.cursors.read('p1')).toBe(0)
    expect(await paused.inbox.unhandled('p1')).toHaveLength(1)

    const resumed = harness()
    const outcomes = await resumed.inbound.recover({ botId: 'b1', projectId: 'p1' })
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['ran'])
    expect(resumed.calls).toHaveLength(1)
  })
})

describe('a message nothing can deliver', () => {
  it('is parked after a few attempts, named, and stops blocking the messages behind it', async () => {
    // A thread pointing at a deleted or retired chat throws the same way every time. Replaying it
    // forever is worse than either answering or losing it: the entry would stay unhandled, so
    // `blocked-by-unhandled` stops the cursor and every later message queues behind one that can never
    // be dealt with — the bot goes deaf for good, with the owner seeing only log lines.
    const test = harness({ failSend: true })
    // The bad message's conversation is already bound, so it takes the follow-up path that fails.
    await test.threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })
    const attempts: number[] = []
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      attempts.push(
        await test.inbound
          .handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
          .then(
            (outcome) => (outcome.kind === 'parked' ? attempt : -attempt),
            () => -attempt
          )
      )
    }

    // Two attempts threw (the stream resumes from the checkpoint between them), the third parked it.
    expect(attempts).toEqual([-1, -2, 3])
    const parked = await test.inbox.read('p1', 'msg_1')
    expect(parked?.parkedReason).toMatch(/This chat is closed/)
    // Parked means handled, so the cursor may pass it and later messages are not stuck behind it.
    expect(parked?.handledAt).toBeDefined()
    expect(await test.cursors.read('p1')).toBe(41)
    expect(await test.inbox.unhandled('p1')).toEqual([])
    expect(test.parked).toEqual(['This chat is closed.'])
    // The message itself is kept, not deleted: the answer the person is waiting for is still readable.
    expect(await test.inbox.parked('p1')).toHaveLength(1)
  })

  it('retries a delivery that only fails once, rather than parking it', async () => {
    const test = harness({ refusedSend: 'This chat is closed.' })
    await test.threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })

    await expect(
      test.inbound.handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
    ).rejects.toThrow('This chat is closed.')
    // One failure is a retry, not a verdict: nothing is parked and the entry is still unhandled.
    expect(await test.inbox.parked('p1')).toEqual([])
    expect((await test.inbox.read('p1', 'msg_1'))?.attempts).toBe(1)
    expect(test.inbox.unhandled('p1')).toBeTruthy()
    expect(await test.cursors.read('p1')).toBe(0)
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
    await test.threads.bind('b1', 'conv_2', { chatId: 'chat_1', handle: '+15551230000' })

    await expect(
      test.inbound.handle({
        botId: 'b1',
        projectId: 'p1',
        seq: 47,
        message: message({ id: 'msg_47', conversationId: 'conv_2', text: 'any news?' })
      })
    ).rejects.toThrow('This chat is closed.')

    // The refusal is not a delivery: the message stays unhandled for the recovery, not silently acked.
    expect((await test.inbox.read('p1', 'msg_47'))?.handledAt).toBeUndefined()
    expect(await test.cursors.read('p1')).toBe(41)
    expect((await test.inbox.unhandled('p1')).map((entry) => entry.messageId)).toEqual(['msg_47'])
  })
})
