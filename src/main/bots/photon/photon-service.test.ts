import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../shared/bot-types'
import { botConnectorServices } from '../../../shared/bots/bot-connectors-view'
import { PhotonApi } from './photon-api'
import { photonBotPeople } from './photon-bot-people'
import { PhotonCursorStore } from './photon-cursor'
import { PhotonInbound } from './photon-inbound'
import { PhotonInbox } from './photon-inbox'
import { PhotonOutbox } from './photon-outbox'
import { PhotonProvisioner } from './photon-provisioning'
import { PhotonSendPath } from './photon-send'
import { photonChannelStatus } from './photon-runtime'
import { PhotonService } from './photon-service'
import { PhotonSpectrumChannels } from './photon-spectrum-channels'
import { PhotonSpectrumSecrets } from './photon-spectrum-secrets'
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
  const spectrumSecrets = new PhotonSpectrumSecrets(userDataPath)
  const inbound = new PhotonInbound({
    inbox,
    cursors,
    threads,
    people: async () => new Map(),
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
    streams: new PhotonStreams({ store, cursors, inbound, sendPath, io, log: () => {} }),
    // No Spectrum project is connected here, and the fake server speaks the Beta API only.
    spectrum: new PhotonSpectrumChannels({
      store,
      cursors,
      secrets: spectrumSecrets,
      inbound,
      sendPath,
      createApp: () => Promise.reject(new Error('the service tests open no Spectrum stream')),
      log: () => {}
    }),
    spectrumSecrets
  })
  return { runtime, store, threads, outbox, inbox }
}

const service = () => serviceWith(io)

describe('the channel', () => {
  it('refuses to create a bot before anything is connected, with a sentence that says what to do', async () => {
    const { runtime } = service()
    await expect(
      runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    ).rejects.toThrow(/not connected/)
  })

  it('keeps the account key only when the owner opts in, and works either way', async () => {
    const { runtime, store } = service()
    expect(
      await runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: false })
    ).toMatchObject({ stored: false })
    // Nothing was written, and the key still works: "not stored" is not "not connected".
    expect(await store.accountCredential()).toEqual({ kind: 'account', key: 'pho_ask_1' })
    expect(await new PhotonStore(userDataPath).accountCredential()).toBeNull()

    await runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    expect(await store.accountKey()).toBe('pho_ask_1')
  })

  it('reports connected on the default path, where the key is held only for the session', async () => {
    // The status read a second PhotonStore over the same files, but the session key lives on the
    // service's own instance — so with `storesKey: false`, the default, a successful connect reported
    // `connected: false`.
    const { runtime } = service()
    await runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: false })

    const status = await photonChannelStatus(runtime, [])
    expect(status).toMatchObject({ connected: true, accountKeyStored: false })
  })

  it('creates a bot after a restart on the unstored path, with the key passed to the call', async () => {
    // The blocker: with `storesKey: false` every account-key operation failed, so the default was
    // broken and the toggle was mandatory. The organization is kept; only the key is not.
    const first = service()
    await first.runtime.connect({
      organizationId: 'org_1',
      accountKey: 'pho_ask_1',
      storesKey: false
    })
    await first.runtime.createBot({ botId: 'b0', botName: 'First', handle: '+15551230000' })

    // A restart: the session key is gone and the organization is not.
    const restarted = service()
    expect(await restarted.store.accountCredential()).toBeNull()
    const created = await restarted.runtime.createBot({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15559990000',
      accountKey: 'pho_ask_pasted'
    })

    expect(created.createdProject).toBe(true)
    expect(server.state.projects.size).toBe(2)
    // The pasted key is held for the session and still not written.
    expect(await new PhotonStore(userDataPath).accountKey()).toBeNull()
    expect(await restarted.store.accountCredential()).toEqual({
      kind: 'account',
      key: 'pho_ask_pasted'
    })
  })

  it('creates the project once, from the name, and gives the bot a number', async () => {
    const { runtime, store } = service()
    await runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })

    // The socket factory refuses, so a create that let a stream failure escape would fail here.
    const created = await runtime.createBot({
      botId: 'b1',
      botName: 'Scout',
      handle: '+15551230000'
    })

    expect(created.createdProject).toBe(true)
    expect((await store.bot('b1'))?.slug).toBe('orca-bot-scout-7dc96f77')
    expect(server.state.projects.size).toBe(1)
    expect((await store.bot('b1'))?.phoneNumber).toBeTruthy()
  })

  it('adds and releases one person, and the handles are the allowlist', async () => {
    const { runtime, store } = service()
    await runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })

    const added = await runtime.addMember({ botId: 'b1', handle: '+15559990000' })
    expect(added.phoneNumber).toBeTruthy()
    expect((await photonBotPeople(store, 'b1')).get('+15559990000')).toMatchObject({
      role: 'member'
    })
    expect((await photonBotPeople(store, 'b1')).get('+15551230000')).toMatchObject({
      role: 'owner'
    })

    await runtime.releaseMember({ botId: 'b1', handle: '+15559990000' })
    expect((await photonBotPeople(store, 'b1')).has('+15559990000')).toBe(false)
    expect(server.state.assignments.size).toBe(1)
  })

  it('keeps both assignments when two people are added at once', async () => {
    // Each add reads the record, awaits the provider, then writes it back. Written onto the record read
    // before that await, the second write erases the first assignment from this computer's mirror — and
    // from then on that member's texts are dropped as an unknown sender, which no reconcile recovers
    // because the mirror is the thing that was wrong.
    const { runtime, store } = service()
    await runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })

    await Promise.all([
      runtime.addMember({ botId: 'b1', handle: '+15559990000' }),
      runtime.addMember({ botId: 'b1', handle: '+15558880000' })
    ])

    const people = await photonBotPeople(store, 'b1')
    expect([...people.keys()].sort()).toEqual(['+15551230000', '+15558880000', '+15559990000'])
    expect(server.state.assignments.size).toBe(3)
  })

  it('does not resurrect a released channel when an add was already in flight', async () => {
    // The release writes `released: true`; an add that read the record before it writes it back with
    // `released: false`, and a live channel is left on a bot that no longer exists.
    const { runtime, store } = service()
    await runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })

    await Promise.all([
      runtime.addMember({ botId: 'b1', handle: '+15559990000' }),
      runtime.deleteBot('b1')
    ])

    expect((await store.bot('b1'))?.released).toBe(true)
  })

  it('tells `orca bot connectors` what the bot answers on and who may text it', async () => {
    const { runtime, store } = service()
    await runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })

    const row = botConnectorServices(
      botForRow,
      { gh: 'signed-in', linear: false },
      undefined,
      (await runtime.statusFor('b1')) ?? undefined
    ).find((entry) => entry.source === 'photon')

    expect(row).toMatchObject({ source: 'photon', tool: 'iMessage' })
    expect(row?.detail).toMatch(/\+15551230000/)
    expect((await store.bot('b1'))?.assignments.map((entry) => entry.handle)).toEqual([
      '+15551230000'
    ])
  })

  it('deleting the bot releases the number and keeps the project', async () => {
    const { runtime, store } = service()
    await runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    const projectId = (await store.bot('b1'))?.projectId

    const outcome = await runtime.deleteBot('b1')

    expect(outcome.projectKept).toBe(true)
    expect(server.state.deleted).toEqual([])
    expect(server.state.projects.has(projectId ?? '')).toBe(true)
    // A tombstone, not nothing: the record still names the project its deletion has to burn, so the
    // separate cleanup stays reachable.
    expect(await store.bot('b1')).toMatchObject({ released: true, projectId, assignments: [] })
    const deleted = await runtime.deleteProject({
      botId: 'b1',
      confirmSlug: 'orca-bot-scout-7dc96f77'
    })
    expect(deleted.terminal).toBe(true)
    expect(await store.bot('b1')).toBeNull()
  })

  it('refuses to admit anybody to a bot it does not have a channel for', async () => {
    const { runtime } = service()
    await runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    await runtime.deleteBot('b1')

    await expect(runtime.addMember({ botId: 'b1', handle: '+15559990000' })).rejects.toThrow(
      /was released/
    )
  })

  it('reports a half-provisioned bot as not connected rather than as a number to text', async () => {
    const { store, runtime } = service()
    await store.putBot({
      botId: 'b2',
      projectId: 'p2',
      slug: 'orca-bot-half',
      organizationId: 'org_1',
      completedThrough: 'project'
    })

    // "add someone to give it one" was the old copy for a bot whose own assignment failed.
    expect(await runtime.statusFor('b2')).toBeNull()
  })

  it('validates a project deletion before it takes the stream down', async () => {
    const quietIo: PhotonIoFactory = () => ({ on: () => {}, emit: () => {}, disconnect: () => {} })
    const streaming = serviceWith(quietIo)
    await streaming.runtime.connect({
      organizationId: 'org_1',
      accountKey: 'pho_ask_1',
      storesKey: true
    })
    await streaming.runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    // `createBot` opens the stream without waiting on it, so wait for it rather than assuming it.
    await vi.waitFor(async () => expect(await streaming.runtime.streamStatus('b1')).not.toBeNull())
    const before = await streaming.runtime.streamStatus('b1')

    // A typo must not leave the bot deaf until the next restart: the check runs before the stop.
    await expect(
      streaming.runtime.deleteProject({ botId: 'b1', confirmSlug: 'wrong' })
    ).rejects.toThrow(/confirmation names/)
    expect((await streaming.runtime.streamStatus('b1'))?.state).toBe(before?.state)
    expect(await streaming.store.bot('b1')).not.toBeNull()
  })
})

describe('a parked message', () => {
  it('is offered another chance at startup, which is the only route back it has', async () => {
    // Parked means handled, so `unhandled()` skips it and the stream never sees it again. Without the
    // startup unpark the route back is "an acked message that is never answered", which is what the
    // design forbids — so the service, not just the store, has to call it.
    const { runtime, store, inbox } = service()
    await store.putBot({
      botId: 'b1',
      projectId: 'pho_prj_parked',
      slug: 'orca-bot-scout-7dc96f77',
      organizationId: 'org_1'
    })
    await store.putProjectKey('b1', { keyId: 'k1', secret: 'pho_sk_1' })
    await inbox.claim(
      'pho_prj_parked',
      {
        id: 'msg_1',
        conversationId: 'conv_1',
        sender: { handle: '+15551230000' },
        text: 'any news?',
        createdAt: 1
      },
      41
    )
    await inbox.park('pho_prj_parked', 'msg_1', 'This chat is closed.')
    expect(await inbox.parked('pho_prj_parked')).toHaveLength(1)

    runtime.startStreams()

    // The replay that follows consumes the entry in this fixture (no assigned handle, so it is ignored
    // and acked), which is why the assertion is on the route back rather than on what the replay did
    // with it: the parked set emptying is the unpark, and it cannot empty any other way.
    await vi.waitFor(async () => expect(await inbox.parked('pho_prj_parked')).toEqual([]))
  })
})

describe('the health tick', () => {
  it('retries a send that failed instead of leaving it in the outbox forever', async () => {
    const { runtime, outbox, threads } = service()
    await runtime.connect({ organizationId: 'org_1', accountKey: 'pho_ask_1', storesKey: true })
    await runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    await threads.bind('b1', 'conv_1', { chatId: 'chat_1', handle: '+15551230000' })
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

    // The tick retries the queued send; the outbox emptying is what it reports, polled rather than slept
    // through so a failure says which send never landed.
    await runtime.healthTick()
    await vi.waitFor(async () => expect(await outbox.pendingFor('b1')).toEqual([]))
    expect(server.state.sent.map((entry) => entry.text)).toEqual(['the build is green'])
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
    await streaming.runtime.connect({
      organizationId: 'org_1',
      accountKey: 'pho_ask_1',
      storesKey: true
    })
    await streaming.runtime.createBot({ botId: 'b1', botName: 'Scout', handle: '+15551230000' })
    // `startStream` is fire-and-forget for a caller that just provisioned, so wait for the socket rather
    // than assuming it exists by the time `createBot` resolves.
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0]?.connect()
    expect(await streaming.runtime.streamStatus('b1')).toMatchObject({
      connected: true,
      subscribed: false
    })

    await streaming.runtime.healthTick()

    // A fresh socket was opened, so the deaf stream was replaced rather than merely reported.
    expect(sockets).toHaveLength(2)
  })
})

describe('the connectors row for a bot with no project', () => {
  it('is absent rather than claiming an iMessage channel that does not exist', async () => {
    const rows = botConnectorServices(botForRow, { gh: 'signed-in', linear: false })
    expect(rows.some((entry) => entry.source === 'photon')).toBe(false)
  })
})
