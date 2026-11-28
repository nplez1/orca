import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PhotonApi } from './photon-api'
import { PhotonOutbox } from './photon-outbox'
import { PhotonColdStartError, PhotonSendPath, foldTurnResult, turnResultText } from './photon-send'
import { PhotonStore } from './photon-store'
import { PhotonThreadMap } from './photon-thread-map'
import { startFakePhotonServer, type FakePhotonServer } from './photon-fake-server.test-fixture'

let server: FakePhotonServer
let userDataPath: string
const credential = { kind: 'project' as const, key: 'pho_sk_project' }

beforeAll(async () => {
  server = await startFakePhotonServer()
})
afterAll(async () => {
  await server.close()
})
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-photon-send-'))
  server.state.sent.length = 0
  // The server replays a repeated Idempotency-Key as the same message, so a key from the previous test
  // would swallow this one's send.
  server.state.idempotency.clear()
  server.state.failNextSend = undefined
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

async function harness() {
  const store = new PhotonStore(userDataPath)
  const outbox = new PhotonOutbox(store)
  const threads = new PhotonThreadMap(store)
  const sendPath = new PhotonSendPath({
    api: new PhotonApi({ baseUrl: server.baseUrl }),
    outbox,
    threads,
    log: () => {}
  })
  // The conversation exists because an inbound message opened it, which is the only way one does.
  await threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })
  return { sendPath, outbox, threads, store }
}

describe('one send per finished turn', () => {
  it('sends once for a turn that emitted many progress items', async () => {
    const test = await harness()
    const items = [
      { role: 'user', text: 'is the build green?' },
      { role: 'progress', text: 'reading the workflow' },
      { role: 'progress', text: 'running the tests' },
      { role: 'progress', text: 'opening the log' },
      { role: 'assistant', text: 'The build is green; all 412 tests passed.' }
    ]
    const finalText = turnResultText(items)
    expect(finalText).toBe('The build is green; all 412 tests passed.')
    if (!finalText) {
      throw new Error('expected a final message')
    }

    const outcome = await test.sendPath.sendTurnResult({
      botId: 'b1',
      projectId: 'pho_prj_1',
      conversationId: 'conv_1',
      credential,
      text: finalText,
      turnId: 'turn_1'
    })

    expect(outcome.sent).toBe(true)
    expect(server.state.sent).toHaveLength(1)
    expect(server.state.sent[0]?.text).toBe('The build is green; all 412 tests passed.')
  })

  it('sends nothing when a turn produced no answer to send', () => {
    expect(turnResultText([{ role: 'progress', text: 'still working' }])).toBeNull()
  })

  it('cuts a long answer to one message and says so, rather than claiming a file it never sent', async () => {
    const test = await harness()
    const long = 'line\n'.repeat(2_000)
    const payload = foldTurnResult(long, { inlineMax: 280 })
    expect(payload.kind).toBe('text')
    expect(payload.truncated).toBe(true)
    expect(payload.body).toMatch(/cut here/)
    // The old copy promised "the full answer is in the attached file" while nothing was uploaded.
    expect(payload.body).not.toMatch(/attached/i)

    const outcome = await test.sendPath.sendTurnResult({
      botId: 'b1',
      projectId: 'pho_prj_1',
      conversationId: 'conv_1',
      credential,
      text: long,
      turnId: 'turn_1'
    })

    expect(outcome).toMatchObject({ sent: true, truncated: true })
    expect(server.state.sent).toHaveLength(1)
    expect(server.state.sent[0]?.text).toMatch(/cut here/)
  })

  it('sends two identical answers in one thread as two messages', async () => {
    // Keyed on the text, the second "Yes." would be a no-op or a replayed response and the person would
    // hear one answer to two questions.
    const test = await harness()
    for (const turnId of ['turn_1', 'turn_2']) {
      await test.sendPath.sendTurnResult({
        botId: 'b1',
        projectId: 'pho_prj_1',
        conversationId: 'conv_1',
        credential,
        text: 'Yes.',
        turnId
      })
    }

    expect(server.state.sent.map((entry) => entry.text)).toEqual(['Yes.', 'Yes.'])
    // And the keys differ: one key for both would be one message replayed rather than two answers.
    expect(new Set(server.state.sent.map((entry) => entry.idempotencyKey)).size).toBe(2)
  })

  it('refuses to send to a conversation Orca never had', async () => {
    const test = await harness()
    await expect(
      test.sendPath.sendTurnResult({
        botId: 'b1',
        projectId: 'pho_prj_1',
        conversationId: 'conv_unknown',
        credential,
        text: 'hello?',
        turnId: 'turn_1'
      })
    ).rejects.toBeInstanceOf(PhotonColdStartError)
    expect(server.state.sent).toEqual([])
  })
})

describe('an answer the horizon passed on', () => {
  it('is recorded as owed rather than dropped quietly', async () => {
    // The design promises the answer "retries, rather than vanishing"; this is where the retrying stops,
    // and the promise is kept honest by naming what was owed instead of leaving a console line.
    let clock = 1_000
    const store = new PhotonStore(userDataPath)
    const outbox = new PhotonOutbox(store, () => clock)
    const threads = new PhotonThreadMap(store)
    await threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })
    const owed: string[] = []
    const sendPath = new PhotonSendPath({
      api: new PhotonApi({ baseUrl: server.baseUrl }),
      outbox,
      threads,
      log: () => {},
      noteUndelivered: (_botId, reason) => {
        owed.push(reason)
      }
    })
    server.state.failNextSend = 503

    const first = await sendPath.sendTurnResult({
      botId: 'b1',
      projectId: 'pho_prj_1',
      conversationId: 'conv_1',
      credential,
      text: 'the build is green',
      turnId: 'turn_1'
    })
    expect(first.sent).toBe(false)
    // Inside the horizon it is still a retry, and nothing is reported as owed yet.
    expect(owed).toEqual([])

    clock += 6 * 60 * 60 * 1000
    server.state.failNextSend = 503
    await sendPath.retryPending('b1', credential)

    expect(owed).toEqual([
      'Photon POST /projects/pho_prj_1/platforms/imessage/messages failed: 503 {"error":"injected"}'
    ])
    expect(await outbox.pendingFor('b1')).toEqual([])
  })
})

describe('a send whose entry is gone by the time it fails', () => {
  it('is not reported as an undelivered answer', async () => {
    // `retryPending` runs from every tick as `void`, so it overlaps live sends. If the entry is settled or
    // forgotten while an attempt is in flight, that failure is not a lost answer — counting it told the
    // owner someone was owed a reply that had in fact been delivered, or that belonged to a bot released
    // minutes ago.
    let clock = 1_000
    const store = new PhotonStore(userDataPath)
    const outbox = new PhotonOutbox(store, () => clock)
    const threads = new PhotonThreadMap(store)
    await threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })
    const owed: string[] = []
    const api = new PhotonApi({ baseUrl: server.baseUrl })
    const sendPath = new PhotonSendPath({
      api,
      outbox,
      threads,
      log: () => {},
      noteUndelivered: (_botId, reason) => {
        owed.push(reason)
      }
    })
    server.state.failNextSend = 503
    await sendPath.sendTurnResult({
      botId: 'b1',
      projectId: 'pho_prj_1',
      conversationId: 'conv_1',
      credential,
      text: 'the build is green',
      turnId: 'turn_1'
    })
    expect(await outbox.pendingFor('b1')).toHaveLength(1)

    // The bot is released while the retry is in flight: the entry goes, and the failure that follows is
    // about an answer nobody is waiting for any more.
    const sendMessage = api.sendMessage.bind(api)
    api.sendMessage = async () => {
      await outbox.forget('b1')
      clock += 6 * 60 * 60 * 1000
      throw new Error('This chat is closed.')
    }
    await sendPath.retryPending('b1', credential)
    api.sendMessage = sendMessage

    expect(owed).toEqual([])
  })
})

describe('a send that fails', () => {
  it('leaves the turn’s result recorded and retries it rather than letting it vanish', async () => {
    const test = await harness()
    server.state.failNextSend = 503

    const failed = await test.sendPath.sendTurnResult({
      botId: 'b1',
      projectId: 'pho_prj_1',
      conversationId: 'conv_1',
      credential,
      text: 'the build is green',
      turnId: 'turn_1'
    })
    expect(failed.sent).toBe(false)
    expect(await test.outbox.pendingFor('b1')).toHaveLength(1)
    expect(server.state.sent).toEqual([])

    const retried = await test.sendPath.retryPending('b1', credential)
    expect(retried).toEqual([{ sent: true, entryId: expect.any(String), truncated: false }])
    expect(server.state.sent).toMatchObject([
      { conversationId: 'conv_1', text: 'the build is green', idempotencyKey: expect.any(String) }
    ])
    expect(await test.outbox.pendingFor('b1')).toEqual([])
  })

  it('retries with the same idempotency key, so a send that may have landed is not doubled', async () => {
    const test = await harness()
    server.state.failNextSend = 500
    await test.sendPath.sendTurnResult({
      botId: 'b1',
      projectId: 'pho_prj_1',
      conversationId: 'conv_1',
      credential,
      text: 'the build is green',
      turnId: 'turn_1'
    })
    const pendingKey = (await test.outbox.pendingFor('b1'))[0]?.id
    await test.sendPath.retryPending('b1', credential)

    expect(server.state.sent[0]?.idempotencyKey).toBe(`photon-send-${pendingKey}`)
  })
})

describe('a bot that answers on its own Spectrum channel', () => {
  /** A send path whose transport is the one thing under test: the HTTP client is never reached. */
  async function withTransport(
    transport: (botId: string) => { send: (id: string, text: string) => Promise<void> } | null
  ) {
    const store = new PhotonStore(userDataPath)
    const outbox = new PhotonOutbox(store)
    const threads = new PhotonThreadMap(store)
    const sendPath = new PhotonSendPath({
      api: new PhotonApi({ baseUrl: server.baseUrl }),
      outbox,
      threads,
      transport,
      log: () => {}
    })
    await threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })
    return { sendPath, outbox }
  }

  it('sends through the channel instead of the HTTP client, and needs no project key to do it', async () => {
    const sent: string[] = []
    const test = await withTransport(() => ({
      send: async (conversationId, text) => {
        sent.push(`${conversationId}:${text}`)
      }
    }))

    // No credential at all: a Spectrum bot has no project key, and the transport is what sends.
    const outcome = await test.sendPath.sendTurnResult({
      botId: 'b1',
      projectId: 'pho_prj_1',
      conversationId: 'conv_1',
      text: 'the build is green',
      turnId: 'turn_1'
    })

    expect(outcome).toMatchObject({ sent: true })
    expect(sent).toEqual(['conv_1:the build is green'])
    expect(server.state.sent).toEqual([])
    expect(await test.outbox.pendingFor('b1')).toEqual([])
  })

  it('keeps the answer queued when no channel is live, rather than failing it against the HTTP client', async () => {
    const test = await withTransport(() => null)

    const outcome = await test.sendPath.sendTurnResult({
      botId: 'b1',
      projectId: 'pho_prj_1',
      conversationId: 'conv_1',
      text: 'the build is green',
      turnId: 'turn_1'
    })

    expect(outcome.sent).toBe(false)
    expect(await test.outbox.pendingFor('b1')).toHaveLength(1)
    expect(server.state.sent).toEqual([])
  })
})
