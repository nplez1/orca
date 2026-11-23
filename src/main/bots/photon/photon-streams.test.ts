// The tick that keeps the channel's streams honest, tested over a socket the test drives. Its two
// promises are the ones a status nobody polls could not keep: a stream that stopped itself is restarted
// *after cancelling its own resume*, and a stream that is connected but never subscribed is restarted
// rather than merely reported.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PhotonCursorStore } from './photon-cursor'
import { PhotonStore } from './photon-store'
import type { PhotonIoFactory, PhotonSocket } from './photon-stream'
import { PhotonStreams, type PhotonTimer } from './photon-streams'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-photon-streams-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

type FakeSocket = PhotonSocket & {
  readonly emitted: { event: string; payload: unknown }[]
  fire: (event: string, payload?: unknown) => void
  disconnected: boolean
}

/** A socket the test drives; every one it makes is kept so a leaked reconnect is countable. */
function harness(handler: () => Promise<void>) {
  const sockets: FakeSocket[] = []
  // A cancelled timer must not run, which is what `clearTimeout` buys in production: modelling it is
  // what makes "the resume was cancelled" observable as "no socket opened".
  const timers: { callback: () => void; cancelled: boolean }[] = []
  const runTimer = (timer: { callback: () => void; cancelled: boolean }): void => {
    if (!timer.cancelled) {
      timer.callback()
    }
  }
  const io: PhotonIoFactory = () => {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
    const socket: FakeSocket = {
      emitted: [],
      disconnected: false,
      on: (event, listener) => handlers.set(event, [...(handlers.get(event) ?? []), listener]),
      emit: (event, payload) => socket.emitted.push({ event, payload }),
      disconnect: () => {
        socket.disconnected = true
      },
      fire: (event, payload) => {
        for (const listener of handlers.get(event) ?? []) {
          listener(payload)
        }
      }
    }
    sockets.push(socket)
    return socket
  }
  const store = new PhotonStore(userDataPath)
  const streams = new PhotonStreams({
    store,
    cursors: new PhotonCursorStore(store),
    // The two seams this suite is about, typed as the narrow slices the code actually calls.
    inbound: { handle: handler },
    sendPath: { retryPending: async () => [] },
    io,
    log: () => {},
    setTimer: (callback) => {
      const timer = { callback, cancelled: false }
      timers.push(timer)
      return {
        cancel: () => {
          timer.cancelled = true
        }
      } satisfies PhotonTimer
    },
    clearTimer: (timer) => timer.cancel()
  })
  return { streams, store, sockets, timers, runTimer }
}

const frame = (seq: number) => ({
  seq,
  message: {
    id: `msg_${seq}`,
    conversationId: 'conv_1',
    sender: { handle: '+15551230000', name: 'Sam' },
    text: 'hello',
    createdAt: 1
  }
})

describe('the health tick', () => {
  it('cancels a self-stopped stream’s resume before starting its replacement', async () => {
    // A handler failure leaves the stream stopped with a resume timer armed. Dropping the map entry and
    // starting a replacement let that timer reconnect a socket nothing references any more: no stop(),
    // no stopAll() and no release can reach it, and it grows one per tick once the backoff passes the
    // interval — with the replacement starting at resumes = 0, so the backoff never grows either.
    const test = harness(async () => {
      throw new Error('the chat this thread points at is gone')
    })
    await test.store.putBot({
      botId: 'b1',
      projectId: 'pho_prj_1',
      slug: 'orca-bot-scout-7dc96f77',
      organizationId: 'org_1'
    })
    await test.store.putProjectKey('b1', { keyId: 'k1', secret: 'pho_sk_1' })

    await test.streams.start('b1')
    test.sockets[0]?.fire('connect')
    test.sockets[0]?.fire('message', frame(41))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The stream stopped itself and armed a resume; that timer is the leak.
    expect(test.streams.status('b1')).toMatchObject({
      state: 'stopped',
      stoppedBy: 'handler-failure'
    })
    // The last timer armed is the resume `failAndResume` scheduled, after the liveness deadline it
    // disarmed.
    const resume = test.timers.at(-1)

    await test.streams.tick()

    expect(resume?.cancelled).toBe(true)
    // Firing the cancelled timer must not open a third socket: that is the leaked reconnect.
    if (resume) {
      test.runTimer(resume)
    }
    expect(test.sockets).toHaveLength(2)
  })

  it('restarts a stream that is connected but never subscribed, rather than only calling it deaf', async () => {
    const test = harness(async () => {})
    await test.store.putBot({
      botId: 'b1',
      projectId: 'pho_prj_1',
      slug: 'orca-bot-scout-7dc96f77',
      organizationId: 'org_1'
    })
    await test.store.putProjectKey('b1', { keyId: 'k1', secret: 'pho_sk_1' })

    await test.streams.start('b1')
    // Connected, and the subscribe is never acknowledged: connected and deaf.
    test.sockets[0]?.fire('connect')
    expect(test.streams.status('b1')).toMatchObject({ connected: true, subscribed: false })

    await test.streams.tick()

    expect(test.sockets).toHaveLength(2)
    expect(test.sockets[0]?.disconnected).toBe(true)
  })

  it('leaves a live stream alone, so the tick is not a reconnect loop', async () => {
    const test = harness(async () => {})
    await test.store.putBot({
      botId: 'b1',
      projectId: 'pho_prj_1',
      slug: 'orca-bot-scout-7dc96f77',
      organizationId: 'org_1'
    })
    await test.store.putProjectKey('b1', { keyId: 'k1', secret: 'pho_sk_1' })

    await test.streams.start('b1')
    test.sockets[0]?.fire('connect')
    test.sockets[0]?.fire('subscribed', { projectId: 'pho_prj_1', startSeq: 0 })

    await test.streams.tick()

    expect(test.sockets).toHaveLength(1)
  })
})
