import { describe, expect, it, vi } from 'vitest'
import type { PhotonIoFactory, PhotonSocket } from './photon-stream'
import { PhotonStream } from './photon-stream'
import { PhotonStreamFrameSchema } from './photon-contract'

/** A socket a test can drive: it records what was emitted, and can be told to drop and reconnect. */
class FakeSocket implements PhotonSocket {
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  readonly emitted: { event: string; payload: unknown }[] = []
  disconnected = false

  on(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload })
  }

  disconnect(): void {
    this.disconnected = true
  }

  /** Fires an event at every handler registered for it. */
  fire(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload)
    }
  }

  get subscribes(): unknown[] {
    return this.emitted.filter((entry) => entry.event === 'subscribe').map((entry) => entry.payload)
  }
}

type TestTimer = {
  callback: () => void
  cancelled: boolean
}

function harness(
  options: { cursor?: () => number; onFrame?: (frame: unknown) => void | Promise<void> } = {}
) {
  const sockets: FakeSocket[] = []
  const timers: TestTimer[] = []
  let cursor = 41
  const io: PhotonIoFactory = () => {
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  }
  const frames: unknown[] = []
  const stream = new PhotonStream({
    io,
    url: 'https://photon.test',
    projectId: 'pho_prj_1',
    credential: 'pho_sk_1',
    readCursor: options.cursor ?? (() => cursor),
    onFrame: (frame) => {
      frames.push(frame)
      return options.onFrame?.(frame)
    },
    livenessTimeoutMs: 5_000,
    log: () => {},
    setTimer: (callback) => {
      const timer: TestTimer = { callback, cancelled: false }
      timers.push(timer)
      return {
        cancel: () => {
          timer.cancelled = true
        }
      }
    }
  })
  return {
    stream,
    /** The current socket; every test connects one before using it. */
    socket: (): FakeSocket => {
      const current = sockets.at(-1)
      if (!current) {
        throw new Error('no socket was created')
      }
      return current
    },
    sockets,
    frames,
    timers,
    setCursor: (next: number) => {
      cursor = next
    }
  }
}

const frame = (seq: number, id = `msg_${seq}`) => ({
  seq,
  message: {
    id,
    conversationId: 'conv_1',
    sender: { handle: '+15551230000', name: 'Sam' },
    text: 'hello',
    createdAt: 1
  }
})

describe('the stream', () => {
  it('subscribes with the saved cursor as soon as the socket connects', () => {
    const test = harness()
    test.stream.start()
    test.socket().fire('connect')

    expect(test.socket().subscribes).toEqual([{ projectId: 'pho_prj_1', startSeq: 41 }])
    expect(test.stream.status()).toMatchObject({ connected: true, subscribed: false })
  })

  it('resubscribes after a reconnect with the cursor Orca checkpointed since, not the original', () => {
    const test = harness()
    test.stream.start()
    test.socket().fire('connect')
    test.socket().fire('subscribed', { projectId: 'pho_prj_1', startSeq: 41 })

    // A turn finished while the socket was up, so the checkpoint moved on.
    test.setCursor(47)
    test.socket().fire('disconnect')
    test.socket().fire('connect')

    expect(test.socket().subscribes).toEqual([
      { projectId: 'pho_prj_1', startSeq: 41 },
      { projectId: 'pho_prj_1', startSeq: 47 }
    ])
    expect(test.stream.status().subscribes).toBe(2)
  })

  it('catches a reconnect that forgot to resubscribe instead of hearing silence', () => {
    const test = harness()
    test.stream.start()
    test.socket().fire('connect')
    test.socket().fire('subscribed', { projectId: 'pho_prj_1', startSeq: 41 })
    expect(() => test.stream.assertLive()).not.toThrow()

    // The resubscribe went out and was never acknowledged — what a reconnect that forgot to ask for the
    // cursor looks like from here. The liveness deadline is what turns it into a refusal rather than
    // silence.
    test.socket().fire('disconnect')
    test.timers.at(-1)?.callback()
    expect(test.stream.status()).toMatchObject({ connected: false, subscribed: false })
    expect(() => test.stream.assertLive()).toThrow(/not connected|never resubscribed/)
  })

  it('delivers frames in order even when an early one is slow', async () => {
    // Frames share one cursor, so a later frame finishing first would move it past an earlier one. Both
    // the order and the "47 has not run yet" are asserted on what the handler saw, never on a clock.
    const order: number[] = []
    let releaseFirst = (): void => {}
    let firstArrived = (): void => {}
    let bothSeen = (): void => {}
    const held = new Promise<void>((resolve) => (releaseFirst = resolve))
    const began = new Promise<void>((resolve) => (firstArrived = resolve))
    const done = new Promise<void>((resolve) => (bothSeen = resolve))
    const test = harness({
      onFrame: async (raw) => {
        const seq = PhotonStreamFrameSchema.parse(raw).seq
        if (seq === 41) {
          firstArrived()
          await held
        }
        order.push(seq)
        if (order.length === 2) {
          bothSeen()
        }
      }
    })
    test.stream.start()
    test.socket().fire('connect')
    test.socket().fire('message', frame(41))
    test.socket().fire('message', frame(47))

    await began
    // 47 sits behind 41: nothing of it ran while the first was in hand.
    expect(order).toEqual([])
    releaseFirst()
    await done
    expect(order).toEqual([41, 47])
  })

  it('resumes itself after a handler failure instead of going deaf until restart', async () => {
    let attempts = 0
    const test = harness({
      onFrame: () => {
        attempts += 1
        throw new Error('the chat refused the prompt')
      }
    })
    test.stream.start()
    test.socket().fire('connect')
    test.socket().fire('message', frame(42))

    // The stop is what the failure produced, waited on rather than slept through.
    await vi.waitFor(() => expect(test.stream.status().state).toBe('stopped'))
    expect(test.stream.status()).toMatchObject({ state: 'stopped', stoppedBy: 'handler-failure' })
    // The resume is armed, not abandoned: the timer it scheduled starts a fresh socket.
    const resume = test.timers.at(-1)
    expect(resume?.cancelled).toBe(false)
    resume?.callback()

    expect(test.sockets).toHaveLength(2)
    expect(test.stream.status()).toMatchObject({ state: 'connecting', resumes: 1 })
    expect(test.stream.status().stoppedBy).toBeUndefined()
    expect(attempts).toBe(1)
  })

  it('reports a refused handshake rather than sitting in a silent connecting state', () => {
    const test = harness()
    test.stream.start()
    test.socket().fire('connect_error', new Error('middleware refused'))

    expect(test.stream.status()).toMatchObject({ state: 'connecting', connected: false })
    expect(() => test.stream.assertLive()).toThrow(/not connected/)
  })

  it('goes stalled when a subscribe is not acknowledged in time, and says so rather than looking healthy', () => {
    const test = harness()
    test.stream.start()
    test.socket().fire('connect')

    const armed = test.timers.at(-1)
    if (!armed) {
      throw new Error('no liveness deadline was armed')
    }
    armed.callback()

    expect(test.stream.status().state).toBe('stalled')
    expect(() => test.stream.assertLive()).toThrow(/did not acknowledge its subscribe/)
  })

  it('delivers a frame to the handler', async () => {
    const test = harness()
    test.stream.start()
    test.socket().fire('connect')
    test.socket().fire('message', frame(42))
    await Promise.resolve()

    expect(test.frames).toEqual([frame(42)])
  })

  it('stops rather than skipping a message whose handler failed', async () => {
    const sockets: FakeSocket[] = []
    const stream = new PhotonStream({
      io: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      url: 'https://photon.test',
      projectId: 'pho_prj_1',
      credential: 'pho_sk_1',
      readCursor: () => 41,
      onFrame: () => {
        throw new Error('the chat refused the prompt')
      },
      log: () => {}
    })
    stream.start()
    sockets[0]?.fire('connect')
    sockets[0]?.fire('message', frame(42))
    await Promise.resolve()
    await Promise.resolve()

    expect(stream.status()).toMatchObject({ state: 'stopped', stoppedBy: 'handler-failure' })
    expect(sockets[0]?.disconnected).toBe(true)
  })

  it('refuses a frame it cannot read instead of treating it as empty', async () => {
    const test = harness()
    test.stream.start()
    test.socket().fire('connect')
    test.socket().fire('message', { seq: 'not a number' })

    await vi.waitFor(() =>
      expect(test.stream.status()).toMatchObject({ state: 'stopped', stoppedBy: 'contract' })
    )
    expect(test.frames).toEqual([])
  })
})
