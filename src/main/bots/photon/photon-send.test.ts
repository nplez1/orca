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
  server.state.failNextSend = undefined
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

function harness() {
  const store = new PhotonStore(userDataPath)
  const outbox = new PhotonOutbox(store)
  const threads = new PhotonThreadMap(store)
  // The conversation exists because an inbound message opened it, which is the only way one does.
  threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })
  const sendPath = new PhotonSendPath({
    api: new PhotonApi({ baseUrl: server.baseUrl }),
    outbox,
    threads,
    log: () => {}
  })
  return { sendPath, outbox, threads, store }
}

describe('one send per finished turn', () => {
  it('sends once for a turn that emitted many progress items', async () => {
    const test = harness()
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
      botName: 'Scout',
      projectId: 'pho_prj_1',
      conversationId: 'conv_1',
      credential,
      text: finalText
    })

    expect(outcome.sent).toBe(true)
    expect(server.state.sent).toHaveLength(1)
    expect(server.state.sent[0]?.text).toBe('The build is green; all 412 tests passed.')
  })

  it('sends nothing when a turn produced no answer to send', () => {
    expect(turnResultText([{ role: 'progress', text: 'still working' }])).toBeNull()
  })

  it('folds a long answer into one attachment rather than several messages', async () => {
    const test = harness()
    const long = 'line\n'.repeat(2_000)
    const payload = foldTurnResult(long, { botName: 'Scout' })
    expect(payload.kind).toBe('attachment')
    if (payload.kind !== 'attachment') {
      throw new Error('expected an attachment')
    }
    expect(payload.attachment.filename).toMatch(/^scout-answer-[0-9a-f]{8}\.md$/)
    expect(payload.attachment.content).toBe(long.trim())

    const outcome = await test.sendPath.sendTurnResult({
      botId: 'b1',
      botName: 'Scout',
      projectId: 'pho_prj_1',
      conversationId: 'conv_1',
      credential,
      text: long
    })

    expect(outcome).toMatchObject({ sent: true, kind: 'attachment' })
    expect(server.state.sent).toHaveLength(1)
    expect(server.state.sent[0]?.text).toMatch(/the full answer is in the attached file/)
  })

  it('refuses to send to a conversation Orca never had', async () => {
    const test = harness()
    await expect(
      test.sendPath.sendTurnResult({
        botId: 'b1',
        projectId: 'pho_prj_1',
        conversationId: 'conv_unknown',
        credential,
        text: 'hello?'
      })
    ).rejects.toBeInstanceOf(PhotonColdStartError)
    expect(server.state.sent).toEqual([])
  })
})

describe('a send that fails', () => {
  it('leaves the turn’s result recorded and retries it rather than letting it vanish', async () => {
    const test = harness()
    server.state.failNextSend = 503

    const failed = await test.sendPath.sendTurnResult({
      botId: 'b1',
      projectId: 'pho_prj_1',
      conversationId: 'conv_1',
      credential,
      text: 'the build is green'
    })
    expect(failed.sent).toBe(false)
    expect(test.outbox.pendingFor('b1')).toHaveLength(1)
    expect(server.state.sent).toEqual([])

    const retried = await test.sendPath.retryPending('b1', credential)
    expect(retried).toEqual([{ sent: true, entryId: expect.any(String), kind: 'text' }])
    expect(server.state.sent).toEqual([
      { conversationId: 'conv_1', text: 'the build is green', idempotencyKey: expect.any(String) }
    ])
    expect(test.outbox.pendingFor('b1')).toEqual([])
  })

  it('retries with the same idempotency key, so a send that may have landed is not doubled', async () => {
    const test = harness()
    server.state.failNextSend = 500
    await test.sendPath.sendTurnResult({
      botId: 'b1',
      projectId: 'pho_prj_1',
      conversationId: 'conv_1',
      credential,
      text: 'the build is green'
    })
    const pendingKey = test.outbox.pendingFor('b1')[0]?.id
    await test.sendPath.retryPending('b1', credential)

    expect(server.state.sent[0]?.idempotencyKey).toBe(`photon-send-${pendingKey}`)
  })
})
