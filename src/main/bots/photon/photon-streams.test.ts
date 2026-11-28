// The tick that keeps the channel's streams honest, tested over a socket the test drives. Its two
// promises are the ones a status nobody polls could not keep: a stream that stopped itself is restarted
// *after cancelling its own resume*, and a stream that is connected but never subscribed is restarted
// rather than merely reported.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
function harness(
  handler: () => Promise<void>,
  options: { peerChannels?: { tick(): Promise<void> } } = {}
) {
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
    ...(options.peerChannels ? { peerChannels: options.peerChannels } : {}),
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
  it('leaves a backing-off stream to its own resume timer', async () => {
    // A handler failure leaves the stream stopped with a resume timer armed. Restarting it here
    // cancelled that timer and reconnected on the tick instead, which is one socket a minute for
    // ever against a provider that counts them — and the replacement used to start at resumes = 0,
    // so the backoff never grew either. The timer is the mechanism that escalates; the tick must not
    // reach past it, and the entry must stay in the map so stop()/stopAll()/release can still find it.
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

    // The stream stopped itself and armed a resume; that timer is the schedule, not a leak.
    expect(test.streams.status('b1')).toMatchObject({
      state: 'stopped',
      stoppedBy: 'handler-failure'
    })
    // The last timer armed is the resume `failAndResume` scheduled, after the liveness deadline it
    // disarmed.
    const resume = test.timers.at(-1)

    await test.streams.tick()

    expect(resume?.cancelled).toBe(false)
    expect(test.sockets).toHaveLength(1)
    // Firing it is what brings the stream back, exactly once.
    if (resume) {
      test.runTimer(resume)
    }
    expect(test.sockets).toHaveLength(2)
    // Why this pins escalation and not the carry-over: the resumed stream is the same object, and its
    // own timer counts the attempt, so `resumes` grows either way. What it does prove is that the tick
    // did not restart it a second time at zero.
    expect(test.streams.status('b1')?.resumes).toBe(1)
  })

  it('does not restart a stream that stopped on a frame nobody can parse', async () => {
    // The replay hands the same bytes back, so a reconnect re-reads the poison every interval and
    // reports a restart each time: the bot is deaf either way, and pretending otherwise costs
    // sockets and hides the reason.
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
    // A frame that is not a frame at all.
    test.sockets[0]?.fire('message', { nonsense: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(test.streams.status('b1')).toMatchObject({ stoppedBy: 'contract' })

    await test.streams.tick()

    expect(test.sockets).toHaveLength(1)
    expect(test.streams.status('b1')).toMatchObject({ state: 'stopped', stoppedBy: 'contract' })
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

  it('keeps the clock free when a Spectrum start hangs, and does not stack a second peer tick on it', async () => {
    // A peer tick awaits the SDK's `createApp`. Awaiting it here put the next tick behind one bot's hung
    // start-up, so every account-mode stream stopped being health-checked — deaf streams never restarted
    // and queued sends never retried — while the tick that schedules itself never ran again.
    // Why a gate the test releases rather than a deadline it races: the peer start stays in flight until
    // this suite says otherwise, so "the tick finished" is the whole observation. An awaited peer leaves
    // that tick pending for ever and `vi.waitFor` reports the condition that never became true.
    let peerTicks = 0
    let released = false
    let releasePeer = (): void => {}
    const peerGate = new Promise<void>((resolve) => {
      releasePeer = () => {
        released = true
        resolve()
      }
    })
    const test = harness(async () => {}, {
      peerChannels: {
        tick: () => {
          peerTicks += 1
          return peerGate
        }
      }
    })
    await test.store.putBot({
      botId: 'b1',
      projectId: 'pho_prj_1',
      slug: 'orca-bot-scout-7dc96f77',
      organizationId: 'org_1'
    })
    await test.store.putProjectKey('b1', { keyId: 'k1', secret: 'pho_sk_1' })
    await test.streams.start('b1')
    // Connected and never subscribed: the tick's own job is to restart it.
    test.sockets[0]?.fire('connect')

    let ticked = false
    void test.streams.tick().then(() => {
      ticked = true
    })
    await vi.waitFor(() => expect(ticked).toBe(true))

    // Still in flight, so the restart below happened on a tick that did not wait for it.
    expect(released).toBe(false)
    expect(test.sockets).toHaveLength(2)

    // A tick on top of a pending peer start issues no second one.
    await test.streams.tick()
    expect(peerTicks).toBe(1)

    // Releasing it lets the next tick through: the guard is a concurrency limit, not a latch.
    releasePeer()
    await vi.waitFor(async () => {
      await test.streams.tick()
      expect(peerTicks).toBe(2)
    })
  })
})
