// What connecting a bot to an owner's own Spectrum project refuses, and what it does when it accepts: the
// refusals are the safety design, so each one is pinned by the message the owner is meant to read.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectPhotonSpectrum,
  releasePhotonSpectrumChannel,
  startPhotonChannels,
  type PhotonCredentialModesDeps
} from './photon-credential-modes'
import { PhotonApi } from './photon-api'
import { PhotonOutbox } from './photon-outbox'
import { PhotonSpectrumChannels } from './photon-spectrum-channels'
import type { SpectrumApp, SpectrumMessage, SpectrumSpace } from './photon-spectrum-channel'
import { PhotonSpectrumSecrets } from './photon-spectrum-secrets'
import { PhotonStore } from './photon-store'
import { PhotonTeardown } from './photon-teardown'
import { PhotonCursorStore } from './photon-cursor'
import { PhotonInbox } from './photon-inbox'
import { PhotonInbound } from './photon-inbound'
import { PhotonThreadMap } from './photon-thread-map'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-photon-modes-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

const space: SpectrumSpace = { id: 'space_1' }
const sdkMessage = (over: Partial<SpectrumMessage> = {}): SpectrumMessage => ({
  id: 'msg_1',
  direction: 'inbound',
  sender: { id: '+15551230000' },
  content: { type: 'text', text: 'is the build green?' },
  timestamp: new Date(1_700_000_000_000),
  ...over
})

/** One SDK client per channel, with the two facts these tests need: was it closed, and what did it send. */
type FakeClient = { stopped: boolean; projectId: string; sent: string[] }

/**
 * `deferOpen` holds every `createApp` answer until the test calls `openNext`, which is the only way to land
 * something in the window between the SDK opening and the channel being published.
 */
function fakeClients(options: { deferOpen?: boolean } = {}) {
  const clients: FakeClient[] = []
  const waiting: (() => void)[] = []
  const createApp = (credentials: {
    projectId: string
    projectSecret: string
  }): Promise<SpectrumApp> => {
    const record: FakeClient = { stopped: false, projectId: credentials.projectId, sent: [] }
    clients.push(record)
    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const app: SpectrumApp = {
      messages: {
        async *[Symbol.asyncIterator](): AsyncIterableIterator<[SpectrumSpace, SpectrumMessage]> {
          await finished
          yield [space, sdkMessage()]
        }
      },
      async send(_target, content) {
        record.sent.push(content)
      },
      async stop() {
        record.stopped = true
        finish()
      }
    }
    if (!options.deferOpen) {
      return Promise.resolve(app)
    }
    return new Promise<SpectrumApp>((resolve) => {
      waiting.push(() => resolve(app))
    })
  }
  const openNext = (): void => {
    waiting.shift()?.()
  }
  return { clients, createApp, openNext }
}

/** The stores the connect path writes to, over one temporary profile. */
function depsWith(options: {
  probe?: PhotonCredentialModesDeps['probeSpectrum']
  clients?: ReturnType<typeof fakeClients>
}) {
  const store = new PhotonStore(userDataPath)
  const secrets = new PhotonSpectrumSecrets(userDataPath)
  const outbox = new PhotonOutbox(store)
  const inbox = new PhotonInbox(store)
  const clients = options.clients ?? fakeClients()
  const spectrum = new PhotonSpectrumChannels({
    store,
    cursors: new PhotonCursorStore(store),
    secrets,
    inbound: { handle: async () => ({ kind: 'ran' }) },
    inbox,
    createApp: clients.createApp,
    sendPath: { retryPending: async () => [] },
    log: () => {}
  })
  const deps: PhotonCredentialModesDeps = {
    store,
    spectrum,
    spectrumSecrets: secrets,
    outbox,
    probeSpectrum:
      options.probe ??
      (async ({ projectId }) => ({ projectId, name: 'My project', slug: 'my-project' })),
    log: () => {}
  }
  return { deps, store, secrets, outbox, spectrum, inbox, clients }
}

const connect = (
  deps: PhotonCredentialModesDeps,
  input: { botId?: string; projectId?: string; projectSecret?: string; storesSecret?: boolean } = {}
) =>
  connectPhotonSpectrum(deps, {
    botId: input.botId ?? 'b1',
    projectId: input.projectId ?? 'pho_prj_1',
    projectSecret: input.projectSecret ?? 'pho_sk_project_secret',
    storesSecret: input.storesSecret ?? false
  })

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : '')

/** What a call rejected with, asserted as a rejection so a resolved call fails the test loudly. */
async function rejectionOf(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => {
      throw new Error('expected a refusal, and the call resolved')
    },
    (error: unknown) => messageOf(error)
  )
}

describe('connecting a bot to an owner’s own Spectrum project', () => {
  it('refuses while the bot still answers on a project Orca provisioned for it', async () => {
    const { deps, store } = depsWith({})
    await store.putBot({
      mode: 'account',
      botId: 'b1',
      projectId: 'prj_orca',
      slug: 'orca-bot-scout',
      organizationId: 'org_1',
      keyId: 'k1',
      completedThrough: 'assignment',
      createdAt: 1
    })

    expect(await rejectionOf(connect(deps))).toMatch(/Release that channel first/)
    // Nothing was written over a live provision: the record still names the project its key belongs to.
    expect(await store.bot('b1')).toMatchObject({ mode: 'account', projectId: 'prj_orca' })
  })

  it('accepts the same bot once its account channel has been released', async () => {
    const { deps, store } = depsWith({})
    await store.putBot({
      mode: 'account',
      botId: 'b1',
      projectId: 'prj_orca',
      slug: 'orca-bot-scout',
      organizationId: 'org_1',
      completedThrough: 'assignment',
      released: true,
      releasedAt: 2,
      createdAt: 1
    })

    const connected = await connect(deps)

    expect(connected).toMatchObject({ projectId: 'pho_prj_1', slug: 'my-project' })
    expect(await store.bot('b1')).toMatchObject({
      mode: 'spectrum',
      projectId: 'pho_prj_1',
      // The record's own age is carried over, so a bot does not look newly created for being re-pointed.
      createdAt: 1
    })
  })

  it('refuses a released record whose teardown never finished, naming what is still on it', async () => {
    const { deps, store } = depsWith({})
    await store.putBot({
      mode: 'account',
      botId: 'b1',
      projectId: 'prj_orca',
      slug: 'orca-bot-scout',
      organizationId: 'org_1',
      completedThrough: 'assignment',
      keyId: 'k1',
      assignments: [{ assignmentId: 'as_1', handle: '+15551230000', phoneNumber: '+15557654321' }],
      released: true,
      releasedAt: 2,
      createdAt: 1
    })

    expect(await rejectionOf(connect(deps))).toMatch(
      /teardown never finished: 1 number still assigned and an unrevoked project key/
    )

    // Nothing was written over it: the number and the key are still named, so a retried release can
    // finish the job this record exists for.
    expect(await store.bot('b1')).toMatchObject({
      mode: 'account',
      projectId: 'prj_orca',
      keyId: 'k1',
      released: true
    })
    expect((await store.bot('b1'))?.assignments).toHaveLength(1)
  })

  it('keeps the released account record beside the Spectrum one, so its project can still be deleted', async () => {
    const { deps, store } = depsWith({})
    await store.putBot({
      mode: 'account',
      botId: 'b1',
      projectId: 'prj_orca',
      slug: 'orca-bot-scout',
      organizationId: 'org_1',
      completedThrough: 'assignment',
      released: true,
      releasedAt: 2,
      createdAt: 1
    })

    await connect(deps)

    expect(await store.bot('b1')).toMatchObject({
      mode: 'spectrum',
      projectId: 'pho_prj_1',
      // The provisioned project survives as the one a deletion can still name.
      priorProvision: { projectId: 'prj_orca', slug: 'orca-bot-scout' }
    })

    const calls: string[] = []
    const api = new PhotonApi({
      baseUrl: 'http://photon.test',
      newIdempotencyKey: () => 'idem_1',
      fetchImpl: async (input, init) => {
        const path = new URL(input).pathname
        calls.push(`${init.method ?? 'GET'} ${path}`)
        return init.method === 'DELETE'
          ? new Response(null, { status: 202 })
          : new Response(JSON.stringify({ state: 'closed' }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
      }
    })
    const outcome = await new PhotonTeardown({ api, store, log: () => {} }).deleteProject({
      botId: 'b1',
      account: { kind: 'account', key: 'pho_sk_account' },
      confirmSlug: 'orca-bot-scout'
    })

    expect(calls).toEqual(['DELETE /projects/prj_orca', 'GET /projects/prj_orca/closure'])
    expect(outcome.state).toBe('closed')
    // The provisioned identity is gone with the project it named, and the bot's own channel is not:
    // forgetting the whole record here would have left a live Spectrum channel nothing can reach.
    expect((await store.bot('b1'))?.priorProvision).toBeUndefined()
    expect(await store.bot('b1')).toMatchObject({ mode: 'spectrum', projectId: 'pho_prj_1' })
  })

  it('refuses a bot whose record changed while the pair was being proven', async () => {
    let finishProbe: () => void = () => {}
    const probing = new Promise<void>((resolve) => {
      finishProbe = resolve
    })
    const { deps, store } = depsWith({
      probe: async ({ projectId }) => {
        await probing
        return { projectId, name: 'My project', slug: 'my-project' }
      }
    })

    const connecting = connect(deps)
    // A `bots.photon.create` on the same bot lands while the pair is in flight. The refusal has to read the
    // record the write is about to replace, not the one read before the network call, or this claim would
    // write a Spectrum record over a live provision.
    await store.putBot({
      mode: 'account',
      botId: 'b1',
      projectId: 'prj_orca',
      slug: 'orca-bot-scout',
      organizationId: 'org_1',
      createdAt: 1
    })
    finishProbe()

    expect(await rejectionOf(connecting)).toMatch(/already answers on an Orca-provisioned/)
    expect(await store.bot('b1')).toMatchObject({ mode: 'account', projectId: 'prj_orca' })
  })

  it('refuses to re-point a bot that is reading another project right now', async () => {
    const { deps, spectrum } = depsWith({})
    await connect(deps)
    await vi.waitFor(() => expect(spectrum.running('b1')).toBe(true))

    expect(await rejectionOf(connect(deps, { projectId: 'pho_prj_2' }))).toMatch(
      /cannot be pointed at pho_prj_2 without releasing this channel first/
    )
  })

  it('applies a rotated secret to the same project by replacing the channel that read the old one', async () => {
    const { deps, spectrum, clients } = depsWith({})
    await connect(deps)
    await vi.waitFor(() => expect(spectrum.running('b1')).toBe(true))
    expect(clients.clients).toHaveLength(1)

    await connect(deps, { projectSecret: 'pho_sk_rotated_secret' })

    // The old client is closed rather than left reading with a secret that no longer works, and a second
    // one is opened with the new secret.
    await vi.waitFor(() => expect(clients.clients).toHaveLength(2))
    expect(clients.clients[0]?.stopped).toBe(true)
    await vi.waitFor(() => expect(spectrum.running('b1')).toBe(true))
  })

  it('refuses a project another bot already reads, because one project has one inbox', async () => {
    const { deps } = depsWith({})
    await connect(deps, { botId: 'b1' })

    expect(await rejectionOf(connect(deps, { botId: 'b2' }))).toMatch(/already connected to bot b1/)
  })

  it('claims a free project for one of two connects racing it, and refuses the other', async () => {
    const { deps, store } = depsWith({})

    const outcomes = await Promise.allSettled([
      connect(deps, { botId: 'b1' }),
      connect(deps, { botId: 'b2' })
    ])

    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    expect(
      outcomes.filter(
        (entry) =>
          entry.status === 'rejected' && /already connected to bot b1/.test(messageOf(entry.reason))
      )
    ).toHaveLength(1)
    expect((await store.bots()).filter((entry) => entry.mode === 'spectrum')).toHaveLength(1)
  })

  it('probes the pair before writing anything, so a wrong secret leaves no channel behind', async () => {
    const { deps, store, secrets } = depsWith({
      probe: async () => {
        throw new Error('Spectrum refused that project id and project secret.')
      }
    })

    expect(await rejectionOf(connect(deps))).toMatch(/refused that project id/)
    expect(await store.bot('b1')).toBeNull()
    expect(await secrets.secret('b1')).toBeNull()
  })

  it('keeps queued answers through a rotated secret, and settles them when the project changes', async () => {
    const { deps, outbox, spectrum } = depsWith({})
    await connect(deps)
    await vi.waitFor(() => expect(spectrum.running('b1')).toBe(true))
    await outbox.enqueue({
      id: 'send_1',
      botId: 'b1',
      projectId: 'pho_prj_1',
      conversationId: 'space_1',
      body: 'the build is green',
      truncated: false
    })

    // A rotated secret keeps them: the conversations they name are the same project's.
    await connect(deps, { projectSecret: 'pho_sk_rotated_secret' })
    expect(await outbox.pendingFor('b1')).toHaveLength(1)

    // A different project settles them: those conversations are ones it has never heard of, and the retry
    // horizon would otherwise end them one by one with the bot's status showing owed answers that were
    // never sendable.
    await vi.waitFor(() => expect(spectrum.running('b1')).toBe(true))
    spectrum.stop('b1')
    await connect(deps, { projectId: 'pho_prj_2' })
    expect(await outbox.pendingFor('b1')).toEqual([])
  })
})

describe('starting every channel at once', () => {
  it('replays what Orca never dealt with without waiting for a Spectrum client to open', async () => {
    const { deps, store, inbox } = depsWith({})
    await store.putBot({ mode: 'account', botId: 'b_account', projectId: 'prj_1', createdAt: 1 })
    await inbox.claim(
      'prj_1',
      {
        id: 'msg_held',
        conversationId: 'space_1',
        sender: { handle: '+15551230000' },
        text: 'is the build green?',
        createdAt: 1
      },
      1
    )
    const inbound = new PhotonInbound({
      inbox,
      cursors: new PhotonCursorStore(store),
      threads: new PhotonThreadMap(store),
      people: async () => new Map(),
      startConversation: async () => ({ chatId: 'chat_1' }),
      sendToChat: async () => {},
      log: () => {}
    })
    // A start-up that never finishes: one bot's SDK, against every bot's mail.
    deps.spectrum.startAll = () => new Promise<void>(() => {})

    await startPhotonChannels({
      store,
      inbox,
      inbound,
      streams: { startAll: async () => {} },
      spectrum: deps.spectrum,
      log: () => {}
    })

    // The held message was replayed while the Spectrum start-up was still pending: the replay is what the
    // inbox exists for, and one hanging SDK must not hold it.
    await vi.waitFor(async () => expect(await inbox.unhandled('prj_1')).toEqual([]))
  })
})

describe('releasing a channel on the owner’s own project', () => {
  it('stops reading, forgets the secret and the record, and releases nothing upstream', async () => {
    const { deps, store, secrets, spectrum, clients } = depsWith({})
    await connect(deps, { storesSecret: true })
    await vi.waitFor(() => expect(spectrum.running('b1')).toBe(true))

    const outcome = await releasePhotonSpectrumChannel(deps, 'b1')

    expect(outcome).toEqual({
      botId: 'b1',
      released: [],
      revokedKey: false,
      projectKept: true,
      problems: []
    })
    expect(spectrum.running('b1')).toBe(false)
    expect(clients.clients[0]?.stopped).toBe(true)
    expect(await secrets.secret('b1')).toBeNull()
    expect(await store.bot('b1')).toBeNull()
  })

  it('is not the account path’s release, and says so by doing nothing for one', async () => {
    const { deps, store } = depsWith({})
    await store.putBot({
      mode: 'account',
      botId: 'b1',
      projectId: 'prj_orca',
      organizationId: 'org_1',
      createdAt: 1
    })

    expect(await releasePhotonSpectrumChannel(deps, 'b1')).toBeNull()
    expect(await store.bot('b1')).not.toBeNull()
  })

  it('stops a client that finished opening during the release, so no channel outlives its record', async () => {
    const clients = fakeClients({ deferOpen: true })
    const { deps, store, spectrum } = depsWith({ clients })
    await connect(deps, { storesSecret: true })
    // The start is fire-and-forget, so the SDK is reached a turn or two after the connect answers.
    await vi.waitFor(() => expect(clients.clients).toHaveLength(1))

    // The release is held on its forget of the outbox, which is a step it reaches after forgetting the
    // record. The SDK answers inside that window, and a client published here would be a channel nothing
    // can stop: the tick only walks store records, and this record is about to go.
    let finishOutbox: () => void = () => {}
    const outboxHeld = new Promise<void>((resolve) => {
      finishOutbox = resolve
    })
    const releasing = releasePhotonSpectrumChannel(
      { ...deps, outbox: { forget: () => outboxHeld } },
      'b1'
    )
    clients.openNext()
    // Wait for the start to have decided: either it closed the client (right) or it published a channel
    // (the leak this pins). Letting the release finish first would hide which one happened.
    await vi.waitFor(() =>
      expect(clients.clients[0]?.stopped === true || spectrum.running('b1')).toBe(true)
    )
    finishOutbox()
    await releasing

    expect(clients.clients[0]?.stopped).toBe(true)
    expect(spectrum.running('b1')).toBe(false)
    expect(await store.bot('b1')).toBeNull()
  })
})
