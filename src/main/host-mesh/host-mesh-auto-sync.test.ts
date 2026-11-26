import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startHostMeshAutoSync,
  nudgeHostMeshSync,
  stopHostMeshAutoSync,
  type HostMeshAutoSyncOutcome
} from './host-mesh-auto-sync'

/**
 * The mesh's own cadence, driven by fake timers.
 *
 * What is worth proving: nothing needs a button, a burst of the same event costs one pass, a fleet that answers
 * nobody gets quieter rather than louder, and a nudge that lands mid-pass is not lost.
 */

const STARTUP_MS = 5_000
const REACHED_ALL = { reached: 1, members: 1 }
const REACHED_NONE = { reached: 0, members: 1 }

/** A pass that records each call, so a test can count them and say what it found. */
function passRecorder(outcome: HostMeshAutoSyncOutcome = REACHED_ALL): {
  calls: number[]
  run: () => Promise<HostMeshAutoSyncOutcome>
} {
  const calls: number[] = []
  return {
    calls,
    run: async () => {
      calls.push(calls.length)
      return outcome
    }
  }
}

afterEach(() => {
  stopHostMeshAutoSync()
  vi.useRealTimers()
})

describe('the mesh keeps itself current', () => {
  it('runs a first pass on its own, then one a minute later', async () => {
    vi.useFakeTimers()
    const recorder = passRecorder()
    startHostMeshAutoSync({ run: recorder.run, startupDelayMs: STARTUP_MS })

    expect(recorder.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(STARTUP_MS)
    expect(recorder.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(recorder.calls).toHaveLength(2)
  })

  it('collapses a burst of the same event into one early pass', async () => {
    vi.useFakeTimers()
    const recorder = passRecorder()
    startHostMeshAutoSync({ run: recorder.run, startupDelayMs: STARTUP_MS })

    nudgeHostMeshSync()
    nudgeHostMeshSync()
    nudgeHostMeshSync()
    await vi.advanceTimersByTimeAsync(1_500)

    expect(recorder.calls).toHaveLength(1)
  })

  it('backs off when a pass reaches nobody, and returns to the normal cadence when one lands', async () => {
    vi.useFakeTimers()
    let outcome: HostMeshAutoSyncOutcome = REACHED_NONE
    const calls: number[] = []
    startHostMeshAutoSync({
      startupDelayMs: STARTUP_MS,
      run: async () => {
        calls.push(calls.length)
        return outcome
      }
    })

    // t=5s: nobody answered, so the next attempt is two minutes out rather than one.
    await vi.advanceTimersByTimeAsync(STARTUP_MS)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(2)

    // The fleet wakes: one pass that reaches it undoes the doubling, without a restart.
    outcome = REACHED_ALL
    await vi.advanceTimersByTimeAsync(240_000)
    expect(calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(4)
  })

  it('backs off when a pass throws, which is the same fact', async () => {
    vi.useFakeTimers()
    const calls: number[] = []
    let failing = true
    startHostMeshAutoSync({
      startupDelayMs: STARTUP_MS,
      run: async () => {
        if (failing) {
          throw new Error('unreachable')
        }
        calls.push(calls.length)
        return REACHED_ALL
      }
    })

    await vi.advanceTimersByTimeAsync(STARTUP_MS)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls).toHaveLength(0)

    failing = false
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(2)
  })

  it('keeps a nudge that arrives while a pass is running', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<void>()
    let release = gate.resolve
    const calls: number[] = []
    startHostMeshAutoSync({
      startupDelayMs: STARTUP_MS,
      run: async () => {
        calls.push(calls.length)
        if (calls.length === 1) {
          // The first pass is still in flight when the connection change arrives.
          await gate.promise
          release = () => undefined
        }
        return REACHED_ALL
      }
    })

    await vi.advanceTimersByTimeAsync(STARTUP_MS)
    nudgeHostMeshSync()
    release()
    await vi.advanceTimersByTimeAsync(1_500)

    // Two, not three: the nudge was not dropped, and it did not queue a second pass behind the first.
    expect(calls).toHaveLength(2)
  })

  it('ignores a second start, so two callers cannot double the cadence', async () => {
    vi.useFakeTimers()
    const recorder = passRecorder()
    startHostMeshAutoSync({ run: recorder.run, startupDelayMs: STARTUP_MS })
    startHostMeshAutoSync({ run: recorder.run, startupDelayMs: STARTUP_MS })

    await vi.advanceTimersByTimeAsync(STARTUP_MS)
    expect(recorder.calls).toHaveLength(1)
  })

  it('stops scheduling after a stop', async () => {
    vi.useFakeTimers()
    const recorder = passRecorder()
    startHostMeshAutoSync({ run: recorder.run, startupDelayMs: STARTUP_MS })
    stopHostMeshAutoSync()

    await vi.advanceTimersByTimeAsync(STARTUP_MS * 4)
    nudgeHostMeshSync()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(recorder.calls).toHaveLength(0)
  })
})
