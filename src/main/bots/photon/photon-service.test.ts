import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from '../../../shared/bot-types'
import { botConnectorServices } from '../../../shared/bots/bot-connectors-view'
import { PhotonApi } from './photon-api'
import { PhotonCursorStore } from './photon-cursor'
import { PhotonInbound } from './photon-inbound'
import { PhotonInbox } from './photon-inbox'
import { PhotonOutbox } from './photon-outbox'
import { PhotonProvisioner } from './photon-provisioning'
import { PhotonSendPath } from './photon-send'
import { PhotonService } from './photon-service'
import { PhotonStore } from './photon-store'
import { PhotonTeardown } from './photon-teardown'
import { PhotonThreadMap } from './photon-thread-map'
import type { PhotonIoFactory } from './photon-stream'
import { startFakePhotonServer, type FakePhotonServer } from './photon-fake-server.test-fixture'

let server: FakePhotonServer
let userDataPath: string

beforeAll(async () => {
  server = await startFakePhotonServer()
})
afterAll(async () => {
  await server.close()
})
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-photon-service-'))
  server.state.projects.clear()
  server.state.idempotency.clear()
  server.state.keys.clear()
  server.state.assignments.clear()
  server.state.sent.length = 0
  server.state.deleted.length = 0
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

/** The Bot fields the connectors view reads; nothing here is about the bot record itself. */
const botForRow: Pick<Bot, 'slack' | 'linear' | 'github'> = {
  slack: null,
  linear: null,
  github: null
}

/** No socket is ever opened: these assertions are about the record, not the transport. */
const io: PhotonIoFactory = () => {
  throw new Error('the service tests do not open a stream')
}

function service() {
  const store = new PhotonStore(userDataPath)
  const api = new PhotonApi({ baseUrl: server.baseUrl })
  const threads = new PhotonThreadMap(store)
  const outbox = new PhotonOutbox(store)
  const cursors = new PhotonCursorStore(store)
  const inbox = new PhotonInbox(store)
  const runtime = new PhotonService({
    store,
    api,
    inbox,
    cursors,
    threads,
    outbox,
    provisioner: new PhotonProvisioner({ api, store, log: () => {} }),
    teardown: new PhotonTeardown({ api, store, log: () => {}, sleep: async () => {} }),
    inbound: new PhotonInbound({
      inbox,
      cursors,
      threads,
      people: () => new Map(),
      startConversation: async () => ({ chatId: 'chat_1' }),
      sendToChat: async () => {},
      log: () => {}
    }),
    sendPath: new PhotonSendPath({ api, outbox, threads, log: () => {} }),
    io
  })
  return { runtime, store, threads }
}

describe('the channel', () => {
  it('refuses to create a bot before anything is connected, with a sentence that says what to do', async () => {
    const { runtime } = service()
    await expect(
      runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    ).rejects.toThrow(/not connected/)
  })

  it('keeps the account key only when the owner opts in', () => {
    const { runtime, store } = service()
    expect(
      runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: false })
    ).toMatchObject({ stored: false })
    expect(store.accountKey()).toBeNull()

    runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    expect(store.accountKey()).toBe('pho_ask_1')
  })

  it('creates the project once, from the name, and gives the bot a number', async () => {
    const { runtime, store } = service()
    runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })

    // The socket factory refuses, so a create that let a stream failure escape would fail here.
    const created = await runtime.createBot({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000'
    })

    expect(created.createdProject).toBe(true)
    expect(store.bot('b1')?.slug).toBe('orca-bot-scout')
    expect(server.state.projects.size).toBe(1)
    expect(store.bot('b1')?.phoneNumber).toBeTruthy()
  })

  it('adds and releases one person, and the handles are the allowlist', async () => {
    const { runtime } = service()
    runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })

    const added = await runtime.addMember({ botId: 'b1', handle: '+15559990000' })
    expect(added.phoneNumber).toBeTruthy()
    expect(runtime.people('b1').get('+15559990000')).toMatchObject({ role: 'member' })
    expect(runtime.people('b1').get('+15551230000')).toMatchObject({ role: 'owner' })

    await runtime.releaseMember({ botId: 'b1', handle: '+15559990000' })
    expect(runtime.people('b1').has('+15559990000')).toBe(false)
    expect(server.state.assignments.size).toBe(1)
  })

  it('tells `orca bot connectors` what the bot answers on and who may text it', async () => {
    const { runtime, store } = service()
    runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })

    const row = botConnectorServices(
      botForRow,
      { gh: 'signed-in', linear: false },
      undefined,
      runtime.statusFor('b1') ?? undefined
    ).find((entry) => entry.source === 'photon')

    expect(row).toMatchObject({ source: 'photon', tool: 'iMessage' })
    expect(row?.detail).toMatch(/\+15551230000/)
    expect(store.bot('b1')?.assignments.map((entry) => entry.handle)).toEqual(['+15551230000'])
  })

  it('deleting the bot releases the number and keeps the project', async () => {
    const { runtime, store } = service()
    runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    const projectId = store.bot('b1')?.projectId

    const outcome = await runtime.deleteBot('b1')

    expect(outcome.projectKept).toBe(true)
    expect(store.bot('b1')).toBeNull()
    expect(server.state.deleted).toEqual([])
    expect(server.state.projects.has(projectId ?? '')).toBe(true)
  })
})

describe('the connectors row for a bot with no project', () => {
  it('is absent rather than claiming an iMessage channel that does not exist', () => {
    const rows = botConnectorServices(botForRow, { gh: 'signed-in', linear: false })
    expect(rows.some((entry) => entry.source === 'photon')).toBe(false)
  })
})
