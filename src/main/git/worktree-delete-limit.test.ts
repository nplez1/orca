import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WORKTREE_DELETE_CONCURRENCY,
  WORKTREE_DELETE_QUEUE_TIMEOUT_MS,
  _worktreeDeleteLimitSnapshotForTests,
  runUnderWorktreeDeleteLimit
} from './worktree-delete-limit'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** A handoff adds an await layer, so a queued delete starts a few microtasks after its slot frees. */
async function flushMicrotasks(): Promise<void> {
  for (let hop = 0; hop < 5; hop++) {
    await Promise.resolve()
  }
}

describe('runUnderWorktreeDeleteLimit', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs at most the limit at once and starts queued deletes in arrival order', async () => {
    const gates = Array.from({ length: WORKTREE_DELETE_CONCURRENCY + 2 }, deferred)
    const started: number[] = []
    const runs = gates.map((gate, index) =>
      runUnderWorktreeDeleteLimit(async () => {
        started.push(index)
        await gate.promise
      })
    )
    await flushMicrotasks()

    expect(started).toEqual([0, 1])
    expect(_worktreeDeleteLimitSnapshotForTests()).toEqual({ running: 2, waiting: 2 })

    gates[1]?.resolve()
    await runs[1]
    await flushMicrotasks()
    expect(started).toEqual([0, 1, 2])

    gates[0]?.resolve()
    gates[2]?.resolve()
    gates[3]?.resolve()
    await Promise.all(runs)
    expect(started).toEqual([0, 1, 2, 3])
    expect(_worktreeDeleteLimitSnapshotForTests()).toEqual({ running: 0, waiting: 0 })
  })

  it('frees the slot when a delete fails', async () => {
    await expect(
      runUnderWorktreeDeleteLimit(async () => {
        throw new Error('locked')
      })
    ).rejects.toThrow('locked')
    expect(_worktreeDeleteLimitSnapshotForTests()).toEqual({ running: 0, waiting: 0 })
  })

  it('gives up waiting for a wedged delete instead of queueing the rest of the session', async () => {
    const wedged = Array.from({ length: WORKTREE_DELETE_CONCURRENCY }, deferred)
    const held = wedged.map((gate) => runUnderWorktreeDeleteLimit(() => gate.promise))
    await flushMicrotasks()

    await expect(runUnderWorktreeDeleteLimit(async () => {}, { waitMs: 5 })).rejects.toThrow(
      'Timed out waiting for another workspace delete to finish after 0s'
    )
    // The abandoned ticket must not consume a slot when the wedge finally clears.
    expect(_worktreeDeleteLimitSnapshotForTests()).toEqual({ running: 2, waiting: 0 })

    wedged[0]?.resolve()
    wedged[1]?.resolve()
    await Promise.all(held)
    expect(_worktreeDeleteLimitSnapshotForTests()).toEqual({ running: 0, waiting: 0 })
  })

  it('hands a slot it won while giving up to the next queued delete', async () => {
    const wedged = Array.from({ length: WORKTREE_DELETE_CONCURRENCY }, deferred)
    const held = wedged.map((gate) => runUnderWorktreeDeleteLimit(() => gate.promise))
    await flushMicrotasks()

    const controller = new AbortController()
    let queuedStarted = false
    const queued = runUnderWorktreeDeleteLimit(
      async () => {
        queuedStarted = true
      },
      { signal: controller.signal, waitMs: 60_000 }
    )
    let behindStarted = false
    const behind = runUnderWorktreeDeleteLimit(async () => {
      behindStarted = true
    })
    await flushMicrotasks()
    expect(_worktreeDeleteLimitSnapshotForTests()).toEqual({ running: 2, waiting: 2 })

    // The slot is handed to `queued` before the abort is observed, so giving up must pass it on.
    wedged[0]?.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(queued).rejects.toThrow('Workspace deletion was cancelled while queued.')
    await behind

    expect(queuedStarted).toBe(false)
    expect(behindStarted).toBe(true)
    wedged[1]?.resolve()
    await Promise.all(held)
    expect(_worktreeDeleteLimitSnapshotForTests()).toEqual({ running: 0, waiting: 0 })
  })

  it('bounds the queue wait by the configured timeout, not the session', () => {
    expect(WORKTREE_DELETE_QUEUE_TIMEOUT_MS).toBeLessThanOrEqual(10 * 60_000)
  })
})
