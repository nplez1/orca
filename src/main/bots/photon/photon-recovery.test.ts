// What happens after the crash the inbox exists for: replaying what Orca wrote down and never dealt with,
// holding a paused bot's mail, and refusing to ack a follow-up that was never delivered.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PhotonInboundMessage } from './photon-contract'
import { PHOTON_INBOX_PARK_HORIZON_MS } from './photon-inbox'
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
  it('is not parked for a failure measured in seconds, and is parked once the horizon passes', async () => {
    // The horizon is time, not a count. The stream resumes after 1 s, 2 s, 4 s, and at startup two
    // replays can consume attempts on one entry back to back — so a count of three parked a message that
    // a provider blip would have delivered a moment later, and a parked entry is marked handled, so
    // nothing would ever answer it.
    let clock = 1_000
    const test = harness({ failSend: true, now: () => clock })
    await test.threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })

    // Three failures a few seconds apart: still a retry, not a verdict.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      clock += 3_000
      await expect(
        test.inbound.handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
      ).rejects.toThrow(/This chat is closed/)
    }
    expect(await test.inbox.parked('p1')).toEqual([])
    expect(await test.cursors.read('p1')).toBe(0)

    // Past the horizon the same message stops being retried, and stops blocking the cursor.
    clock += PHOTON_INBOX_PARK_HORIZON_MS
    const parked = await test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message()
    })
    expect(parked.kind).toBe('parked')
    const entry = await test.inbox.read('p1', 'msg_1')
    expect(entry?.parkedReason).toMatch(/This chat is closed/)
    expect(entry?.handledAt).toBeDefined()
    expect(await test.cursors.read('p1')).toBe(41)
    expect(await test.inbox.unhandled('p1')).toEqual([])
    expect(test.parked).toEqual(['This chat is closed.'])
  })

  it('gives a parked message another chance, which is the only route back it has', async () => {
    // Once parked, the entry has `handledAt`, so `unhandled()` skips it and no live path would ever retry
    // it: an acked message that is never answered. The startup replay unparks first.
    let clock = 1_000
    const test = harness({ failSend: true, now: () => clock })
    await test.threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })
    await test.inbound
      .handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
      .catch(() => undefined)
    clock += PHOTON_INBOX_PARK_HORIZON_MS
    await test.inbound
      .handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
      .catch(() => undefined)
    expect(await test.inbox.parked('p1')).toHaveLength(1)

    // A restart: the entry is out of the parked set and back in the stream's way, so it is retried.
    expect(await test.inbox.unpark('p1')).toBe(1)
    expect(await test.inbox.parked('p1')).toEqual([])
    expect(await test.inbox.unhandled('p1')).toHaveLength(1)
    // And the next attempt is judged from now, not from the failure that parked it.
    expect((await test.inbox.read('p1', 'msg_1'))?.firstFailedAt).toBeUndefined()
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
