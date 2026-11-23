import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PhotonInboundMessage } from './photon-contract'
import type { HarnessOptions } from './photon-inbound.test-harness'
import { inboundHarness } from './photon-inbound.test-harness'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-photon-inbound-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

const harness = (options: HarnessOptions = {}) => inboundHarness(userDataPath, options)

const message = (over: Partial<PhotonInboundMessage> = {}): PhotonInboundMessage => ({
  id: 'msg_1',
  conversationId: 'conv_1',
  sender: { handle: '+15551230000', name: 'Sam' },
  text: 'is the build green?',
  createdAt: 1000,
  ...over
})

describe('an inbound message', () => {
  it('runs once when the same message id arrives twice', async () => {
    const test = harness()
    const first = await test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message()
    })
    const second = await test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message()
    })

    expect(first.kind).toBe('ran')
    expect(second.kind).toBe('replayed')
    expect(test.calls).toHaveLength(1)
    expect(test.calls[0]).toMatchObject({ kind: 'start', text: 'is the build green?' })
  })

  it('continues one chat for two messages in one conversation', async () => {
    const test = harness()
    await test.inbound.handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
    await test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 47,
      message: message({ id: 'msg_2', text: 'and the tests?' })
    })

    expect(test.calls.map((call) => call.kind)).toEqual(['start', 'send'])
    expect(test.calls[1]).toMatchObject({ kind: 'send', chatId: 'chat_1', text: 'and the tests?' })
  })

  it('starts another chat for a new conversation', async () => {
    const test = harness()
    await test.inbound.handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
    const other = await test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 47,
      message: message({ id: 'msg_2', conversationId: 'conv_2' })
    })

    expect(other).toMatchObject({ kind: 'ran', chatId: 'chat_2', continued: false })
    expect(test.calls.map((call) => call.kind)).toEqual(['start', 'start'])
  })

  it('hands the text over with the person Photon says is asking', async () => {
    const test = harness()
    await test.inbound.handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })

    expect(test.calls[0]?.person).toEqual({
      kind: 'person',
      source: 'photon',
      userId: '+15551230000',
      name: 'Sam',
      workspaceId: null,
      role: 'owner'
    })
  })

  it('marks a member as a member rather than as the owner', async () => {
    const test = harness({
      people: new Map([['+15559990000', { name: 'Alex', role: 'member' }]])
    })
    await test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message({ sender: { handle: '+15559990000', name: 'Alex' } })
    })
    expect(test.calls[0]?.person.role).toBe('member')
  })

  it('never turns an unknown handle into an instruction, and says the mirror is stale', async () => {
    const test = harness({ people: new Map() })
    const outcome = await test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message()
    })

    expect(outcome).toEqual({ kind: 'ignored', messageId: 'msg_1', reason: 'unknown-handle' })
    expect(test.calls).toEqual([])
    // Photon only delivers assigned senders, so this is a stale mirror on Orca's side, not a stranger.
    expect(test.unknownSenders).toEqual(['b1'])
    // Recorded and checkpointed, so it is not replayed forever, but nothing ran.
    expect(test.cursors.read('p1')).toBe(41)
  })
})

describe('the cursor against the inbox', () => {
  it('does not advance until the message is durably in Orca’s store', async () => {
    const test = harness()
    await test.inbound.handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })

    // The inbox entry exists and the cursor moved to exactly the seq Photon named, never to seq + 1.
    expect(test.inbox.has('p1', 'msg_1')).toBe(true)
    expect(test.cursors.read('p1')).toBe(41)
  })

  it('leaves the cursor put when the turn could not be dispatched, so the message replays', async () => {
    const test = harness({ failStart: true })
    await expect(
      test.inbound.handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
    ).rejects.toThrow(/would not start/)

    // The payload is on disk, but the cursor did not move: a crash here replays the work.
    expect(test.inbox.has('p1', 'msg_1')).toBe(true)
    expect(test.cursors.read('p1')).toBe(0)
  })

  it('never lets a later frame carry the cursor past one still being dispatched', async () => {
    // seq 41 opens a new conversation and is slow; seq 47 continues a thread and is fast. Handled
    // concurrently, 47 advances the cursor to 47 while 41 is still in hand — and 41, which then fails,
    // is never redelivered because Photon only replays after the highest cursor it was given.
    let releaseFirst = (): void => {}
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve))
    const test = harness({ holdStart: () => firstHeld, failStartFor: 'start X' })

    const slow = test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message({ id: 'msg_41', text: 'start X' })
    })
    const fast = test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 47,
      message: message({ id: 'msg_47', text: 'and Y' })
    })

    // Give the fast one every chance to overtake; it must not touch the cursor.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(test.cursors.read('p1')).toBe(0)
    releaseFirst()
    await expect(slow).rejects.toThrow(/would not start/)
    await fast

    // 47 ran, and the cursor still has not passed 41: 41 is the next thing Photon would hand over, and
    // the inbox holds it as unhandled for the recovery to replay. Without that check 47's success would
    // have moved the cursor to 47 and 41 would never be redelivered.
    expect(test.cursors.read('p1')).toBe(0)
    expect(test.inbox.unhandled('p1').map((entry) => entry.messageId)).toEqual(['msg_41'])
  })

  it('refuses a duplicate delivery of a message that is still being dispatched', async () => {
    // A drop mid-dispatch resubscribes from the pre-message cursor and Photon redelivers the same id.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const test = harness({ holdStart: () => held })

    const first = test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message()
    })
    const duplicate = test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message()
    })
    release()
    await first

    expect(await duplicate).toMatchObject({ kind: 'replayed' })
    // One chat and one run, not two: the second delivery found the first in hand.
    expect(test.calls).toHaveLength(1)
  })

  it('runs a message whose write survived a crash but whose turn never started', async () => {
    const crashed = harness({ failStart: true })
    await expect(
      crashed.inbound.handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
    ).rejects.toThrow()

    // A fresh process, same store: the replay runs the turn instead of skipping it.
    const restarted = harness()
    const outcome = await restarted.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message()
    })
    expect(outcome.kind).toBe('ran')
    expect(restarted.calls).toHaveLength(1)
    expect(restarted.cursors.read('p1')).toBe(41)
  })

  it('absorbs a replay harmlessly when the message was already dispatched', async () => {
    const test = harness()
    await test.inbound.handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
    // The crash came after the dispatch but before the cursor write: replay the same frame.
    const replay = await test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message()
    })

    expect(replay.kind).toBe('replayed')
    expect(test.calls).toHaveLength(1)
    expect(test.cursors.read('p1')).toBe(41)
  })

  it('resumes from a gap by resubscribing, never by adding one', async () => {
    const test = harness()
    await test.inbound.handle({ botId: 'b1', projectId: 'p1', seq: 41, message: message() })
    await test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 47,
      message: message({ id: 'msg_2', text: 'still there?' })
    })
    expect(test.cursors.read('p1')).toBe(47)
  })
})
