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
import { PhotonStreams } from './photon-streams'
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

/** The service over this test's stores: the transport is the only thing a caller varies. */
function serviceWith(io: PhotonIoFactory) {
  const store = new PhotonStore(userDataPath)
  const api = new PhotonApi({ baseUrl: server.baseUrl })
  const threads = new PhotonThreadMap(store)
  const outbox = new PhotonOutbox(store)
  const cursors = new PhotonCursorStore(store)
  const inbox = new PhotonInbox(store)
  const sendPath = new PhotonSendPath({ api, outbox, threads, log: () => {} })
  const inbound = new PhotonInbound({
    inbox,
    cursors,
    threads,
    people: () => new Map(),
    startConversation: async () => ({ chatId: 'chat_1' }),
    sendToChat: async () => {},
    log: () => {}
  })
  const runtime = new PhotonService({
    store,
    api,
    inbox,
    cursors,
    threads,
    outbox,
    provisioner: new PhotonProvisioner({ api, store, log: () => {} }),
    teardown: new PhotonTeardown({ api, store, log: () => {}, sleep: async () => {} }),
    inbound,
    sendPath,
    streams: new PhotonStreams({ store, cursors, inbound, sendPath, io, log: () => {} })
  })
  return { runtime, store, threads }
}

const service = () => serviceWith(io)

describe('the channel', () => {
  it('refuses to create a bot before anything is connected, with a sentence that says what to do', async () => {
    const { runtime } = service()
    await expect(
      runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    ).rejects.toThrow(/not connected/)
  })

  it('keeps the account key only when the owner opts in, and works either way', () => {
    const { runtime, store } = service()
    expect(
      runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: false })
    ).toMatchObject({ stored: false })
    // Nothing was written, and the key still works: "not stored" is not "not connected".
    expect(store.accountCredential()).toEqual({ kind: 'account', key: 'pho_ask_1' })
    expect(new PhotonStore(userDataPath).accountCredential()).toBeNull()

    runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    expect(store.accountKey()).toBe('pho_ask_1')
  })

  it('creates a bot after a restart on the unstored path, with the key passed to the call', async () => {
    // The blocker: with `storesKey: false` every account-key operation failed, so the default was
    // broken and the toggle was mandatory. The organization is kept; only the key is not.
    const first = service()
    first.runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: false })
    await first.runtime.createBot({ botId: 'b0', botName: 'First', handle: '+15551230000' })

    // A restart: the session key is gone and the organization is not.
    const restarted = service()
    expect(restarted.store.accountCredential()).toBeNull()
    const created = await restarted.runtime.createBot({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15559990000',
      accountKey: 'pho_ask_pasted'
    })

    expect(created.createdProject).toBe(true)
    expect(server.state.projects.size).toBe(2)
    // The pasted key is held for the session and still not written.
    expect(new PhotonStore(userDataPath).accountKey()).toBeNull()
    expect(restarted.store.accountCredential()).toEqual({ kind: 'account', key: 'pho_ask_pasted' })
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
    expect(server.state.deleted).toEqual([])
    expect(server.state.projects.has(projectId ?? '')).toBe(true)
    // A tombstone, not nothing: the record still names the project its deletion has to burn, so the
    // separate cleanup stays reachable.
    expect(store.bot('b1')).toMatchObject({ released: true, projectId, assignments: [] })
    const deleted = await runtime.deleteProject({ botId: 'b1', confirmSlug: 'orca-bot-scout' })
    expect(deleted.terminal).toBe(true)
    expect(store.bot('b1')).toBeNull()
  })

  it('refuses to admit anybody to a bot it does not have a channel for', async () => {
    const { runtime } = service()
    runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    await runtime.deleteBot('b1')

    await expect(runtime.addMember({ botId: 'b1', handle: '+15559990000' })).rejects.toThrow(
      /was released/
    )
  })

  it('reports a half-provisioned bot as not connected rather than as a number to text', async () => {
    const { store, runtime } = service()
    store.putBot({
      botId: 'b2',
      projectId: 'p2',
      slug: 'orca-bot-half',
      organizationId: 'org_1',
      completedThrough: 'project'
    })

    // "add someone to give it one" was the old copy for a bot whose own assignment failed.
    expect(runtime.statusFor('b2')).toBeNull()
  })

  it('validates a project deletion before it takes the stream down', async () => {
    const { runtime, store } = service()
    runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    const streamed = runtime.startStream('b1')

    // A typo must not leave the bot deaf until the next restart.
    await expect(runtime.deleteProject({ botId: 'b1', confirmSlug: 'wrong' })).rejects.toThrow(
      /confirmation names/
    )
    expect(runtime.streamStatus('b1')?.state).toBe(streamed?.state)
    expect(store.bot('b1')).not.toBeNull()
  })
})

describe('the health tick', () => {
  it('retries a send that failed instead of leaving it in the outbox forever', async () => {
    const { runtime, store } = service()
    runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    const threads = service().threads
    threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })
    server.state.failNextSend = 503

    // A turn ends and its send fails; nothing used to pick it back up, because `retryPending` had no
    // production caller.
    const failed = await runtime.sendTurnResult({
      botId: 'b1',
      conversationId: 'conv_1',
      text: 'the build is green',
      turnId: 'turn_1'
    })
    expect(failed.sent).toBe(false)

    const ticked = service()
    ticked.runtime.healthTick()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const pending = new PhotonOutbox(store).pendingFor('b1')
    expect(pending).toEqual([])
  })

  it('restarts a stream that is connected but has not subscribed, rather than only calling it deaf', async () => {
    // A socket that connects and never acknowledges a subscribe: connected and deaf, which is the state
    // the `deaf` word in a status nobody polls used to describe without fixing.
    const sockets: { connect: () => void }[] = []
    const socketsIo: PhotonIoFactory = () => {
      const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
      const socket = {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, [...(handlers.get(event) ?? []), handler])
        },
        emit: () => {},
        disconnect: () => {}
      }
      sockets.push({
        connect: () => {
          for (const handler of handlers.get('connect') ?? []) {
            handler()
          }
        }
      })
      return socket
    }
    const streaming = serviceWith(socketsIo)
    streaming.runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await streaming.runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    sockets[0]?.connect()
    expect(streaming.runtime.streamStatus('b1')).toMatchObject({
      connected: true,
      subscribed: false
    })

    streaming.runtime.healthTick()

    // A fresh socket was opened, so the deaf stream was replaced rather than merely reported.
    expect(sockets).toHaveLength(2)
  })
})

describe('the connectors row for a bot with no project', () => {
  it('is absent rather than claiming an iMessage channel that does not exist', () => {
    const rows = botConnectorServices(botForRow, { gh: 'signed-in', linear: false })
    expect(rows.some((entry) => entry.source === 'photon')).toBe(false)
  })
})
