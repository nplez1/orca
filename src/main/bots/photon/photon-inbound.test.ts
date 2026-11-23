import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotRequestPerson } from '../../../shared/bots/bot-acts-for'
import { PhotonCursorStore } from './photon-cursor'
import { PhotonInbound, type PhotonPerson } from './photon-inbound'
import { PhotonInbox } from './photon-inbox'
import { PhotonStore } from './photon-store'
import { PhotonThreadMap } from './photon-thread-map'
import type { PhotonInboundMessage } from './photon-contract'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-photon-inbound-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

type Call = { kind: 'start' | 'send'; chatId?: string; text: string; person: BotRequestPerson }

function harness(options: { people?: Map<string, PhotonPerson>; failStart?: boolean } = {}) {
  const store = new PhotonStore(userDataPath)
  const inbox = new PhotonInbox(store)
  const cursors = new PhotonCursorStore(store)
  const threads = new PhotonThreadMap(store)
  const calls: Call[] = []
  let chats = 0
  const inbound = new PhotonInbound({
    inbox,
    cursors,
    threads,
    people: () => options.people ?? new Map([['+15551230000', { name: 'Sam', role: 'owner' }]]),
    startConversation: async ({ text, person }) => {
      if (options.failStart) {
        throw new Error('the chat would not start')
      }
      chats += 1
      calls.push({ kind: 'start', text, person })
      return { chatId: `chat_${chats}` }
    },
    sendToChat: async ({ chatId, text, person }) => {
      calls.push({ kind: 'send', chatId, text, person })
    },
    log: () => {}
  })
  return { inbound, calls, inbox, cursors, threads, store }
}

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

  it('never turns an unknown handle into an instruction', async () => {
    const test = harness({ people: new Map() })
    const outcome = await test.inbound.handle({
      botId: 'b1',
      projectId: 'p1',
      seq: 41,
      message: message()
    })

    expect(outcome).toEqual({ kind: 'ignored', messageId: 'msg_1', reason: 'unknown-handle' })
    expect(test.calls).toEqual([])
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

  it('resumes from a gap without assuming the next cursor is one more', async () => {
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
