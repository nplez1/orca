// The registry that owns one long-lived SDK client per bot: the two things it must not get wrong — a
// position that repeats after a restart, and a client nothing can reach — plus the tick that replaces a
// channel whose stream ended.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhotonInboundMessage } from './photon-contract'
import { PhotonCursorStore } from './photon-cursor'
import { PhotonInbox } from './photon-inbox'
import type { SpectrumApp, SpectrumMessage, SpectrumSpace } from './photon-spectrum-channel'
import { PhotonSpectrumChannels } from './photon-spectrum-channels'
import { PhotonSpectrumSecrets } from './photon-spectrum-secrets'
import { PhotonStore } from './photon-store'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-photon-channels-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

const space: SpectrumSpace = { id: 'space_1' }

const message = (id: string, over: Partial<PhotonInboundMessage> = {}): PhotonInboundMessage => ({
  id,
  conversationId: space.id,
  sender: { handle: '+15551230000' },
  text: 'is the build green?',
  createdAt: 1,
  ...over
})

const sdkMessage = (id: string): SpectrumMessage => ({
  id,
  direction: 'inbound',
  sender: { id: '+15551230000' },
  content: { type: 'text', text: 'is the build green?' },
  timestamp: new Date(1_700_000_000_000)
})

/** A client whose stream yields what it is given and then waits for `stop`, so it stays live. */
function holdingApp(messages: SpectrumMessage[]) {
  let finish: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const app: SpectrumApp = {
    messages: {
      async *[Symbol.asyncIterator](): AsyncIterableIterator<[SpectrumSpace, SpectrumMessage]> {
        for (const entry of messages) {
          yield [space, entry]
        }
        await finished
      }
    },
    send: async () => undefined,
    stop: async () => {
      finish()
    }
  }
  return app
}

/** A stream that is already over: a channel whose SDK connection ended and nothing is reading. */
function ended(): AsyncIterable<[SpectrumSpace, SpectrumMessage]> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined })
    })
  }
}

/** A client whose stream ends on its own, which is the state the tick exists to replace. */
function endingApp(): SpectrumApp {
  return {
    messages: ended(),
    send: async () => undefined,
    stop: async () => undefined
  }
}

function harness(
  createApp: (input: { projectId: string; projectSecret: string }) => Promise<SpectrumApp>
) {
  const store = new PhotonStore(userDataPath)
  const secrets = new PhotonSpectrumSecrets(userDataPath)
  const inbox = new PhotonInbox(store)
  const cursors = new PhotonCursorStore(store)
  const delivered: { id: string; seq: number }[] = []
  const channels = new PhotonSpectrumChannels({
    store,
    cursors,
    secrets,
    inbox,
    inbound: {
      handle: async (input) => {
        delivered.push({ id: input.message.id, seq: input.seq })
        return { kind: 'ran', messageId: input.message.id, chatId: 'chat_1', continued: false }
      }
    },
    sendPath: { retryPending: async () => [] },
    createApp,
    log: () => {}
  })
  return { store, secrets, inbox, cursors, channels, delivered }
}

/** A bot on an existing project, with the secret it reads with already kept. */
async function botOnProject(
  test: ReturnType<typeof harness>,
  projectId = 'pho_prj_1'
): Promise<void> {
  await test.store.putBot({ mode: 'spectrum', botId: 'b1', projectId })
  await test.secrets.put('b1', { projectId, secret: 'pho_sk_project_secret' })
}

describe('the Spectrum channel registry', () => {
  it('numbers after both the cursor and the highest position its inbox already holds', async () => {
    const test = harness(async () => holdingApp([sdkMessage('msg_new')]))
    await botOnProject(test)
    await test.inbox.claim('pho_prj_1', message('msg_old'), 3)
    await test.cursors.advance('pho_prj_1', 3, {
      inboxHas: async () => true,
      messageId: 'msg_old',
      unhandledAtOrBelow: async () => null
    })
    // Written but never dealt with, so the cursor never moved past it: a restart that seeded from the
    // cursor alone would hand this position out twice.
    await test.inbox.claim('pho_prj_1', message('msg_later'), 7)

    const channel = await test.channels.start('b1')

    expect(channel).not.toBeNull()
    await vi.waitFor(() => expect(test.delivered).toEqual([{ id: 'msg_new', seq: 8 }]))
  })

  it('closes a client that finished opening while a release ran, instead of publishing it', async () => {
    let openClient: (app: SpectrumApp) => void = () => {}
    const stopped: string[] = []
    const test = harness(
      () =>
        new Promise<SpectrumApp>((resolve) => {
          openClient = (app) => resolve(app)
        })
    )
    await botOnProject(test)

    const starting = test.channels.start('b1')
    // The release lands while the SDK is still opening: the record and the secret are gone by the time it
    // answers, and a channel kept now would be a socket nothing can stop.
    await test.store.forgetBot('b1')
    await test.secrets.forget('b1')
    openClient({
      messages: ended(),
      send: async () => undefined,
      stop: async () => {
        stopped.push('b1')
      }
    })

    expect(await starting).toBeNull()
    expect(stopped).toEqual(['b1'])
    expect(test.channels.running('b1')).toBe(false)
  })

  it('hands the send path no transport once the channel’s stream has ended', async () => {
    const test = harness(async () => endingApp())
    await botOnProject(test)

    await test.channels.start('b1')

    await vi.waitFor(() => expect(test.channels.running('b1')).toBe(false))
    expect(test.channels.transportFor('b1')).toBeNull()
  })

  it('replaces a channel whose stream ended on its own, which is what the health tick promises', async () => {
    const opened: SpectrumApp[] = []
    const test = harness(async () => {
      const app = opened.length === 0 ? endingApp() : holdingApp([])
      opened.push(app)
      return app
    })
    await botOnProject(test)
    await test.channels.start('b1')
    await vi.waitFor(() => expect(test.channels.running('b1')).toBe(false))

    await test.channels.tick()

    expect(opened).toHaveLength(2)
    expect(test.channels.running('b1')).toBe(true)
    test.channels.stop('b1')
  })

  it('skips a bot whose record names no project, and one that was released', async () => {
    const opened: SpectrumApp[] = []
    const test = harness(async () => {
      opened.push(endingApp())
      return endingApp()
    })
    await test.store.putBot({ mode: 'account', botId: 'b_account', projectId: 'prj_1' })
    await test.store.putBot({ mode: 'spectrum', botId: 'b_released', projectId: 'pho_prj_2' })
    await test.store.updateBot('b_released', (record) => ({ ...record, released: true }))

    await test.channels.startAll()

    expect(opened).toEqual([])
  })
})
