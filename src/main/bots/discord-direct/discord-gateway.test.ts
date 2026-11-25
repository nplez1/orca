import { describe, expect, it } from 'vitest'
import { DISCORD_DEFAULT_INTENTS, DISCORD_OP } from './discord-contract'
import { createFakeDiscordGateway } from './discord-fake-gateway.test-fixture'
import {
  createDiscordGateway,
  DISCORD_READY_TIMEOUT_MS,
  DISCORD_RECONNECT_MAX_MS,
  DISCORD_ZOMBIE_CLOSE_CODE,
  type DiscordGatewayState
} from './discord-gateway'

type FakeClock = {
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  advance: (ms: number) => void
}

/** Time only moves when a test moves it, and a timer created while time moves fires in the same step. */
function createFakeClock(): FakeClock {
  let current = 0
  let nextId = 1
  const timers = new Map<number, { due: number; fn: () => void }>()
  return {
    now: () => current,
    setTimer: (fn, ms) => {
      const id = nextId
      nextId += 1
      timers.set(id, { due: current + ms, fn })
      return id
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
    advance: (ms) => {
      const target = current + ms
      for (;;) {
        let next: { id: number; due: number; fn: () => void } | undefined
        for (const [id, timer] of timers) {
          if (timer.due <= target && (next === undefined || timer.due < next.due)) {
            next = { id, due: timer.due, fn: timer.fn }
          }
        }
        if (next === undefined) {
          break
        }
        timers.delete(next.id)
        current = next.due
        next.fn()
      }
      current = target
    }
  }
}

/** The gateway's only async step is the URL fetch, so a few microtask turns settle it. */
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 5; tick += 1) {
    await Promise.resolve()
  }
}

function harness(options: { remaining?: number; random?: number } = {}) {
  const clock = createFakeClock()
  const fake = createFakeDiscordGateway({ remaining: options.remaining, now: clock.now })
  const states: DiscordGatewayState[] = []
  const fatals: { reason: string; detail: string }[] = []
  const dispatches: string[] = []
  let random = options.random ?? 0.5
  const gateway = createDiscordGateway({
    token: 'token_1',
    openSocket: fake.openSocket,
    getGatewayUrl: fake.getGatewayUrl,
    now: clock.now,
    random: () => random,
    onDispatch: (event) => dispatches.push(event.t),
    onState: (state) => states.push(state),
    onFatal: (reason, detail) => fatals.push({ reason, detail }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  return {
    clock,
    fake,
    gateway,
    states,
    fatals,
    dispatches,
    setRandom: (next: number): void => {
      random = next
    }
  }
}

const identifyPayload = {
  token: 'token_1',
  intents: DISCORD_DEFAULT_INTENTS,
  properties: { os: process.platform, browser: 'orca', device: 'orca' }
}

describe('the Discord gateway connection', () => {
  it('offsets the first heartbeat by a random fraction, then heartbeats every full interval', async () => {
    const test = harness({ random: 0.5 })
    test.gateway.start()
    await settle()
    const socket = test.fake.current()
    expect(socket.url).toBe('wss://gateway.discord.gg/?v=10&encoding=json')
    socket.hello(45_000)
    socket.ready({ seq: 1 })
    expect(socket.sentWith(DISCORD_OP.IDENTIFY)[0]?.d).toEqual(identifyPayload)

    test.clock.advance(22_499)
    expect(socket.sentWith(DISCORD_OP.HEARTBEAT)).toHaveLength(0)
    test.clock.advance(1)
    expect(socket.sentWith(DISCORD_OP.HEARTBEAT)).toEqual([{ op: DISCORD_OP.HEARTBEAT, d: 1 }])

    socket.heartbeatAck()
    test.clock.advance(44_999)
    expect(socket.sentWith(DISCORD_OP.HEARTBEAT)).toHaveLength(1)
    test.clock.advance(1)
    expect(socket.sentWith(DISCORD_OP.HEARTBEAT)).toHaveLength(2)
  })

  it('answers a server heartbeat request at once, not on the timer', async () => {
    const test = harness()
    test.gateway.start()
    await settle()
    const socket = test.fake.current()
    socket.hello(45_000)
    socket.ready({ seq: 9 })
    socket.requestHeartbeat()
    expect(socket.sentWith(DISCORD_OP.HEARTBEAT)).toEqual([{ op: DISCORD_OP.HEARTBEAT, d: 9 }])
  })

  it('closes a zombie with 4000 and resumes on the next connection', async () => {
    const test = harness({ random: 0.5 })
    test.gateway.start()
    await settle()
    const first = test.fake.current()
    first.hello(45_000)
    first.ready({ sessionId: 'sess_zombie', resumeUrl: 'wss://resume.discord.gg', seq: 7 })

    test.clock.advance(22_500)
    expect(first.sentWith(DISCORD_OP.HEARTBEAT)).toHaveLength(1)
    test.clock.advance(45_000)
    expect(first.closeCodes).toEqual([DISCORD_ZOMBIE_CLOSE_CODE])
    await settle()

    expect(test.fake.sockets).toHaveLength(2)
    const second = test.fake.current()
    expect(second.url).toBe('wss://resume.discord.gg/?v=10&encoding=json')
    second.hello(45_000)
    expect(second.sentWith(DISCORD_OP.RESUME)).toEqual([
      { op: DISCORD_OP.RESUME, d: { token: 'token_1', session_id: 'sess_zombie', seq: 7 } }
    ])
    expect(second.sentWith(DISCORD_OP.IDENTIFY)).toHaveLength(0)
  })

  it('resumes on op 7', async () => {
    const test = harness()
    test.gateway.start()
    await settle()
    const first = test.fake.current()
    first.hello()
    first.ready({ sessionId: 'sess_7', seq: 4 })
    first.reconnect()
    expect(first.closeCodes).toEqual([DISCORD_ZOMBIE_CLOSE_CODE])

    test.clock.advance(0)
    await settle()
    const second = test.fake.current()
    expect(second.url).toBe('wss://resume.discord.gg/?v=10&encoding=json')
    second.hello()
    expect(second.sentWith(DISCORD_OP.RESUME)[0]?.d).toEqual({
      token: 'token_1',
      session_id: 'sess_7',
      seq: 4
    })
  })

  it('resumes on an Invalid Session that is still resumable, after a 1-5 s delay', async () => {
    const test = harness({ random: 0.5 })
    test.gateway.start()
    await settle()
    const first = test.fake.current()
    first.hello()
    first.ready({ sessionId: 'sess_9', seq: 2 })
    first.invalidSession(true)
    expect(first.closeCodes).toEqual([DISCORD_ZOMBIE_CLOSE_CODE])

    test.clock.advance(2_999)
    await settle()
    expect(test.fake.sockets).toHaveLength(1)
    test.clock.advance(1)
    await settle()
    expect(test.fake.sockets).toHaveLength(2)
    const second = test.fake.current()
    second.hello()
    expect(second.sentWith(DISCORD_OP.RESUME)[0]?.d).toEqual({
      token: 'token_1',
      session_id: 'sess_9',
      seq: 2
    })
  })

  it('identifies on an Invalid Session that cannot be resumed', async () => {
    const test = harness({ random: 0.5 })
    test.gateway.start()
    await settle()
    const first = test.fake.current()
    first.hello()
    first.ready({ sessionId: 'sess_gone', seq: 3 })
    first.invalidSession(false)

    test.clock.advance(3_000)
    await settle()
    const second = test.fake.current()
    expect(second.url).toBe('wss://gateway.discord.gg/?v=10&encoding=json')
    second.hello()
    expect(second.sentWith(DISCORD_OP.RESUME)).toHaveLength(0)
    expect(second.sentWith(DISCORD_OP.IDENTIFY)[0]?.d).toEqual(identifyPayload)
  })

  it('stops for good on 4004 and reports an invalid token', async () => {
    const test = harness()
    test.gateway.start()
    await settle()
    test.fake.current().drop(4004)
    expect(test.fatals).toHaveLength(1)
    expect(test.fatals[0]?.reason).toBe('token_invalid')
    expect(test.gateway.getState()).toBe('stopped')

    test.clock.advance(DISCORD_RECONNECT_MAX_MS * 4)
    await settle()
    expect(test.fake.sockets).toHaveLength(1)
  })

  it('stops for good on 4014, a disallowed intent', async () => {
    const test = harness()
    test.gateway.start()
    await settle()
    test.fake.current().drop(4014)
    expect(test.fatals).toHaveLength(1)
    expect(test.fatals[0]?.reason).toBe('intent_rejected')
    expect(test.gateway.getState()).toBe('stopped')

    test.clock.advance(DISCORD_RECONNECT_MAX_MS * 4)
    await settle()
    expect(test.fake.sockets).toHaveLength(1)
  })

  it('reconnects and resumes on 4000', async () => {
    const test = harness({ random: 0.5 })
    test.gateway.start()
    await settle()
    const first = test.fake.current()
    first.hello()
    first.ready({ sessionId: 'sess_4000', seq: 5 })
    first.drop(4000)

    test.clock.advance(999)
    await settle()
    expect(test.fake.sockets).toHaveLength(1)
    test.clock.advance(1)
    await settle()
    const second = test.fake.current()
    expect(second.url).toBe('wss://resume.discord.gg/?v=10&encoding=json')
    second.hello()
    expect(second.sentWith(DISCORD_OP.RESUME)[0]?.d).toEqual({
      token: 'token_1',
      session_id: 'sess_4000',
      seq: 5
    })
  })

  it('identifies on 4009, a timed-out session', async () => {
    const test = harness({ random: 0.5 })
    test.gateway.start()
    await settle()
    const first = test.fake.current()
    first.hello()
    first.ready({ sessionId: 'sess_timed_out', seq: 6 })
    first.drop(4009)

    test.clock.advance(1_000)
    await settle()
    const second = test.fake.current()
    expect(second.url).toBe('wss://gateway.discord.gg/?v=10&encoding=json')
    second.hello()
    expect(second.sentWith(DISCORD_OP.RESUME)).toHaveLength(0)
    expect(second.sentWith(DISCORD_OP.IDENTIFY)).toHaveLength(1)
  })

  it('never connects when the session-start allowance is nearly gone', async () => {
    const test = harness({ remaining: 3 })
    test.gateway.start()
    await settle()
    expect(test.fake.sockets).toHaveLength(0)
    expect(test.fatals).toHaveLength(1)
    expect(test.fatals[0]?.reason).toBe('budget_exhausted')
    expect(test.gateway.getState()).toBe('stopped')
  })

  it('connects while the allowance is at the floor', async () => {
    const test = harness({ remaining: 10 })
    test.gateway.start()
    await settle()
    expect(test.fake.sockets).toHaveLength(1)
    expect(test.fatals).toHaveLength(0)
  })

  it('is deaf when a connect never reaches READY', async () => {
    const test = harness()
    test.gateway.start()
    await settle()
    test.fake.current().hello(45_000)
    test.clock.advance(DISCORD_READY_TIMEOUT_MS - 1)
    expect(test.gateway.isDeaf()).toBe(false)
    test.clock.advance(1)
    expect(test.gateway.isDeaf()).toBe(true)
    expect(test.gateway.getState()).toBe('deaf')
  })

  it('doubles the reconnect delay and caps it at five minutes', async () => {
    const test = harness({ random: 0.5 })
    test.gateway.start()
    await settle()
    const expected = [
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000
    ]
    for (const delay of expected) {
      const before = test.fake.sockets.length
      test.fake.current().drop(4000)
      test.clock.advance(delay - 1)
      await settle()
      expect(test.fake.sockets).toHaveLength(before)
      test.clock.advance(1)
      await settle()
      expect(test.fake.sockets).toHaveLength(before + 1)
    }
  })

  it('resumes on the spot when the system comes back from sleep', async () => {
    const test = harness()
    test.gateway.start()
    await settle()
    const first = test.fake.current()
    first.hello()
    first.ready({ sessionId: 'sess_sleep', seq: 8 })
    test.gateway.handleSleepResume()
    expect(first.closeCodes).toEqual([DISCORD_ZOMBIE_CLOSE_CODE])

    test.clock.advance(0)
    await settle()
    const second = test.fake.current()
    expect(second.url).toBe('wss://resume.discord.gg/?v=10&encoding=json')
    second.hello()
    expect(second.sentWith(DISCORD_OP.RESUME)[0]?.d).toEqual({
      token: 'token_1',
      session_id: 'sess_sleep',
      seq: 8
    })
  })

  it('reconnects at once, and only once, when a wake lands during backoff', async () => {
    const test = harness({ random: 0.5 })
    test.gateway.start()
    await settle()
    test.fake.current().drop(4000)
    test.gateway.handleSleepResume()
    test.clock.advance(0)
    await settle()
    expect(test.fake.sockets).toHaveLength(2)

    test.clock.advance(1_000)
    await settle()
    expect(test.fake.sockets).toHaveLength(2)
  })

  it('counts dispatch frames and reports them with their sequence number', async () => {
    const test = harness()
    test.gateway.start()
    await settle()
    const socket = test.fake.current()
    socket.hello()
    socket.ready({ seq: 1 })
    socket.dispatch('MESSAGE_CREATE', { content: 'hi' }, 2)
    expect(test.dispatches).toEqual(['READY', 'MESSAGE_CREATE'])
    expect(test.gateway.getDispatchCount()).toBe(2)
  })

  it('closes with 1000 and stays stopped', async () => {
    const test = harness()
    test.gateway.start()
    await settle()
    test.gateway.stop()
    expect(test.fake.current().closeCodes).toEqual([1000])
    expect(test.gateway.getState()).toBe('stopped')
    test.clock.advance(DISCORD_RECONNECT_MAX_MS)
    await settle()
    expect(test.fake.sockets).toHaveLength(1)
  })
})
