import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BLOCKED_DEADLINE_DRAIN_MS,
  BLOCKED_DEADLINE_OVERRUN_MS,
  deadlineOverrunField,
  scheduleDeadlineKill
} from './process-deadline'

/**
 * Why a fake clock plus an injected `now()`: lateness is the input to every branch here, and real
 * timers made it depend on machine load — this box has measured a load average of 32, where a
 * 100 ms threshold against real scheduler slack flakes. A test advances the clock to say exactly
 * how late the deadline fired, so no case needs a real `Atomics.wait` stall to mean "blocked".
 */
function testClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('scheduleDeadlineKill', () => {
  it('kills a child that has not exited as soon as an on-time deadline fires', async () => {
    vi.useFakeTimers()
    const clock = testClock()
    const kill = vi.fn()
    scheduleDeadlineKill({
      deadlineMs: 20,
      isSettled: () => false,
      hasExited: () => false,
      kill,
      now: clock.now
    })

    clock.advance(20)
    await vi.advanceTimersByTimeAsync(20)

    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill.mock.calls[0]?.[0]).toBeLessThan(BLOCKED_DEADLINE_OVERRUN_MS)
  })

  it('holds the kill for a child that already exited, bounded by the drain window', async () => {
    // Why this is the shape that matters: `close` — what settles the capture — waits on the stdio
    // pipes and arrives a phase after the immediate, so an exited child is exited but not settled.
    vi.useFakeTimers()
    const clock = testClock()
    const kill = vi.fn()
    scheduleDeadlineKill({
      deadlineMs: 20,
      isSettled: () => false,
      hasExited: () => true,
      kill,
      now: clock.now
    })

    clock.advance(20)
    await vi.advanceTimersByTimeAsync(20 + BLOCKED_DEADLINE_DRAIN_MS - 1)
    expect(kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('leaves a settled child alone', async () => {
    vi.useFakeTimers()
    const clock = testClock()
    const kill = vi.fn()
    scheduleDeadlineKill({
      deadlineMs: 20,
      isSettled: () => true,
      hasExited: () => true,
      kill,
      now: clock.now
    })

    clock.advance(20)
    await vi.advanceTimersByTimeAsync(20 + BLOCKED_DEADLINE_DRAIN_MS + 100)

    expect(kill).not.toHaveBeenCalled()
  })

  it('gives a late deadline the drain window before killing', async () => {
    vi.useFakeTimers()
    const clock = testClock()
    const kill = vi.fn()
    scheduleDeadlineKill({
      deadlineMs: 20,
      isSettled: () => false,
      hasExited: () => false,
      kill,
      now: clock.now
    })

    // 280 ms late: the loop was blocked, so the exit it was waiting for may not have been delivered.
    clock.advance(300)
    await vi.advanceTimersByTimeAsync(20)
    expect(kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(BLOCKED_DEADLINE_DRAIN_MS + 10)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(BLOCKED_DEADLINE_OVERRUN_MS)
  })

  it('cancels a deadline and a drain that is already waiting', async () => {
    vi.useFakeTimers()
    const clock = testClock()
    const kill = vi.fn()
    const deadline = scheduleDeadlineKill({
      deadlineMs: 20,
      isSettled: () => false,
      hasExited: () => true,
      kill,
      now: clock.now
    })

    clock.advance(20)
    await vi.advanceTimersByTimeAsync(60)
    deadline.cancel()
    await vi.advanceTimersByTimeAsync(BLOCKED_DEADLINE_DRAIN_MS + 100)

    expect(kill).not.toHaveBeenCalled()
  })
})

describe('scheduleDeadlineKill after a blocked thread', () => {
  it('holds the kill when a block ended past the deadline with the exit hidden', async () => {
    vi.useFakeTimers()
    const clock = testClock()
    const kill = vi.fn()
    scheduleDeadlineKill({
      deadlineMs: 60,
      isSettled: () => false,
      hasExited: () => true,
      kill,
      now: clock.now
    })

    // 20 ms late: under the block threshold, so only the exit itself can defer the kill.
    clock.advance(80)
    await vi.advanceTimersByTimeAsync(60 + BLOCKED_DEADLINE_DRAIN_MS - 1)
    expect(kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill.mock.calls[0]?.[0]).toBeLessThan(BLOCKED_DEADLINE_OVERRUN_MS)
  })
})

describe('deadlineOverrunField', () => {
  it('reports the lateness only when a block delayed the deadline', () => {
    expect(deadlineOverrunField(null)).toEqual({})
    expect(deadlineOverrunField(BLOCKED_DEADLINE_OVERRUN_MS - 1)).toEqual({})
    expect(deadlineOverrunField(387_550.6)).toEqual({ deadlineOverrunMs: 387_551 })
  })
})
