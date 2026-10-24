import { describe, expect, it, vi } from 'vitest'
import {
  BLOCKED_DEADLINE_DRAIN_MS,
  BLOCKED_DEADLINE_OVERRUN_MS,
  deadlineOverrunField,
  scheduleDeadlineKill
} from './process-deadline'

// Why real timers: these cases need a `setImmediate` to run after a genuine thread block, and the
// block itself is `Atomics.wait` — a fake clock cannot produce either.
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const stallCell = new Int32Array(new SharedArrayBuffer(4))

async function untilCalled(
  spy: { mock: { calls: unknown[][] } },
  timeoutMs = 3_000
): Promise<void> {
  const startedAt = performance.now()
  while (spy.mock.calls.length === 0 && performance.now() - startedAt < timeoutMs) {
    await tick(5)
  }
}

describe('scheduleDeadlineKill', () => {
  it('kills a child that has not exited as soon as an on-time deadline fires', async () => {
    const kill = vi.fn()
    scheduleDeadlineKill({ deadlineMs: 20, isSettled: () => false, hasExited: () => false, kill })
    await untilCalled(kill)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill.mock.calls[0]?.[0]).toBeLessThan(BLOCKED_DEADLINE_OVERRUN_MS)
  })

  it('holds the kill for a child that already exited, bounded by the drain window', async () => {
    // Why this is the shape that matters: `close` — what settles the capture — waits on the stdio
    // pipes and arrives a phase after the immediate, so an exited child is exited but not settled.
    const kill = vi.fn()
    scheduleDeadlineKill({ deadlineMs: 20, isSettled: () => false, hasExited: () => true, kill })
    await tick(BLOCKED_DEADLINE_DRAIN_MS / 2)
    expect(kill).not.toHaveBeenCalled()
    await untilCalled(kill)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('leaves a settled child alone', async () => {
    const kill = vi.fn()
    let settled = false
    scheduleDeadlineKill({ deadlineMs: 20, isSettled: () => settled, hasExited: () => true, kill })
    settled = true
    await tick(BLOCKED_DEADLINE_DRAIN_MS + 100)
    expect(kill).not.toHaveBeenCalled()
  })

  it('gives a late deadline the drain window before killing', async () => {
    const kill = vi.fn()
    scheduleDeadlineKill({ deadlineMs: 20, isSettled: () => false, hasExited: () => false, kill })
    // Why real and blocking: a fake clock cannot reproduce a thread that stops servicing I/O, and
    // `Atomics.wait` blocks this one without yielding to the loop or spending CPU.
    Atomics.wait(stallCell, 0, 0, 300)
    const resumedAt = performance.now()
    expect(kill).not.toHaveBeenCalled()
    await untilCalled(kill)
    expect(kill.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(BLOCKED_DEADLINE_OVERRUN_MS)
    expect(performance.now() - resumedAt).toBeGreaterThanOrEqual(BLOCKED_DEADLINE_DRAIN_MS - 50)
  })

  it('cancels a deadline and a drain that is already waiting', async () => {
    const kill = vi.fn()
    const deadline = scheduleDeadlineKill({
      deadlineMs: 20,
      isSettled: () => false,
      hasExited: () => true,
      kill
    })
    await tick(60)
    deadline.cancel()
    await tick(BLOCKED_DEADLINE_DRAIN_MS + 100)
    expect(kill).not.toHaveBeenCalled()
  })
})

describe('scheduleDeadlineKill across a blocked thread', () => {
  it('holds the kill when a block ended past the deadline with the exit hidden', async () => {
    let exited = false
    const killedAt: number[] = []
    const overruns: number[] = []
    scheduleDeadlineKill({
      deadlineMs: 60,
      isSettled: () => false,
      hasExited: () => exited,
      kill: (overrunMs) => {
        killedAt.push(performance.now())
        overruns.push(overrunMs)
      }
    })
    // ~20 ms late: under the block threshold, so only the exit itself can defer the kill.
    Atomics.wait(stallCell, 0, 0, 80)
    const resumedAt = performance.now()
    exited = true
    await tick(BLOCKED_DEADLINE_DRAIN_MS + 200)
    expect(killedAt).toHaveLength(1)
    expect(killedAt[0]! - resumedAt).toBeGreaterThanOrEqual(BLOCKED_DEADLINE_DRAIN_MS - 50)
    // ...and the lateness is under the threshold, so only the exit could have deferred the kill.
    expect(overruns[0]).toBeLessThan(BLOCKED_DEADLINE_OVERRUN_MS)
  })
})

describe('deadlineOverrunField', () => {
  it('reports the lateness only when a block delayed the deadline', () => {
    expect(deadlineOverrunField(null)).toEqual({})
    expect(deadlineOverrunField(BLOCKED_DEADLINE_OVERRUN_MS - 1)).toEqual({})
    expect(deadlineOverrunField(387_550.6)).toEqual({ deadlineOverrunMs: 387_551 })
  })
})
