import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetEphemeralVmRuntimeLocks,
  tryWithEphemeralVmRuntimeLock,
  withEphemeralVmRuntimeLock
} from './ephemeral-vm-runtime-lock'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** A turn of the microtask queue, so a queued follower would have started if it could. */
async function settleMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  resetEphemeralVmRuntimeLocks()
})

describe('withEphemeralVmRuntimeLock', () => {
  it('runs one operation at a time for the same runtime id', async () => {
    const gate = deferred()
    const order: string[] = []

    const first = withEphemeralVmRuntimeLock('runtime-1', async () => {
      order.push('first:start')
      await gate.promise
      order.push('first:end')
    })
    const second = withEphemeralVmRuntimeLock('runtime-1', async () => {
      order.push('second:start')
    })

    await settleMicrotasks()
    expect(order).toEqual(['first:start'])

    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('runs a queued follower after the holder settles and gives it the holder result', async () => {
    const gate = deferred()
    const order: string[] = []

    const first = withEphemeralVmRuntimeLock('runtime-1', async () => {
      order.push('first')
      await gate.promise
      return 'first-result'
    })
    const second = withEphemeralVmRuntimeLock('runtime-1', async () => {
      order.push('second')
      return 'second-result'
    })

    gate.resolve()

    await expect(first).resolves.toBe('first-result')
    await expect(second).resolves.toBe('second-result')
    expect(order).toEqual(['first', 'second'])
  })

  it('does not serialise unrelated runtime ids', async () => {
    const gate = deferred()
    const started: string[] = []

    const blocked = withEphemeralVmRuntimeLock('runtime-1', async () => {
      started.push('runtime-1')
      await gate.promise
    })
    const other = withEphemeralVmRuntimeLock('runtime-2', async () => {
      started.push('runtime-2')
      return 'runtime-2-result'
    })

    // `other` settling before the gate is released is the whole assertion.
    await expect(other).resolves.toBe('runtime-2-result')
    expect(started).toEqual(['runtime-1', 'runtime-2'])

    gate.resolve()
    await blocked
  })

  it('releases the lock when the holder rejects', async () => {
    await expect(
      withEphemeralVmRuntimeLock('runtime-1', async () => {
        throw new Error('holder failed')
      })
    ).rejects.toThrow('holder failed')

    await expect(
      withEphemeralVmRuntimeLock('runtime-1', async () => 'after-failure')
    ).resolves.toBe('after-failure')
  })

  it('keeps the lock usable when a queued follower itself rejects', async () => {
    const gate = deferred()

    const first = withEphemeralVmRuntimeLock('runtime-1', async () => {
      await gate.promise
      return 'first'
    })
    const second = withEphemeralVmRuntimeLock('runtime-1', async () => {
      throw new Error('follower failed')
    })
    const third = withEphemeralVmRuntimeLock('runtime-1', async () => 'third')

    gate.resolve()

    await expect(first).resolves.toBe('first')
    await expect(second).rejects.toThrow('follower failed')
    await expect(third).resolves.toBe('third')
  })
})

describe('tryWithEphemeralVmRuntimeLock', () => {
  it('runs when the runtime is idle and releases the lock afterwards', async () => {
    const first = tryWithEphemeralVmRuntimeLock('runtime-1', async () => 'first')
    expect(first.ran).toBe(true)
    if (!first.ran) {
      throw new Error('expected the lock to be free')
    }
    await expect(first.promise).resolves.toBe('first')

    const second = tryWithEphemeralVmRuntimeLock('runtime-1', async () => 'second')
    expect(second.ran).toBe(true)
  })

  it('reports busy instead of queueing behind the holder', async () => {
    const gate = deferred()
    const started: string[] = []

    const holder = withEphemeralVmRuntimeLock('runtime-1', async () => {
      started.push('holder')
      await gate.promise
      return 'held'
    })
    const skipped = tryWithEphemeralVmRuntimeLock('runtime-1', async () => {
      started.push('skipped')
      return 'ran'
    })

    // The whole point: a sweep that queued here would wait for a hook that may never answer.
    expect(skipped.ran).toBe(false)
    expect(started).toEqual(['holder'])

    gate.resolve()
    await expect(holder).resolves.toBe('held')
  })

  it('does not hold the lock on behalf of an unrelated runtime', async () => {
    const gate = deferred()
    const holder = withEphemeralVmRuntimeLock('runtime-1', () => gate.promise)

    const other = tryWithEphemeralVmRuntimeLock('runtime-2', async () => 'other')
    expect(other.ran).toBe(true)
    if (!other.ran) {
      throw new Error('expected the other runtime to be free')
    }
    await expect(other.promise).resolves.toBe('other')

    gate.resolve()
    await holder
  })

  it('releases the lock when the operation rejects', async () => {
    const failed = tryWithEphemeralVmRuntimeLock('runtime-1', async () => {
      throw new Error('boom')
    })
    expect(failed.ran).toBe(true)
    if (!failed.ran) {
      throw new Error('expected the lock to be free')
    }
    await expect(failed.promise).rejects.toThrow('boom')

    expect(tryWithEphemeralVmRuntimeLock('runtime-1', async () => 'after').ran).toBe(true)
  })
})
