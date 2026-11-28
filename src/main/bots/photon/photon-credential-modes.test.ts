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
import { PhotonOutbox } from './photon-outbox'
import { PhotonSpectrumChannels } from './photon-spectrum-channels'
import type { SpectrumApp, SpectrumMessage, SpectrumSpace } from './photon-spectrum-channel'
import { PhotonSpectrumSecrets } from './photon-spectrum-secrets'
import { PhotonStore } from './photon-store'
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

function fakeClients() {
  const clients: FakeClient[] = []
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
    return Promise.resolve({
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
    })
  }
  return { clients, createApp }
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
})
