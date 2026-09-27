import { describe, expect, it } from 'vitest'
import { WorkspacePathIndexAdmission } from './workspace-path-index-admission'
import { WorkspacePathIndexQueryScheduler } from './workspace-path-index-query-scheduler'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

async function yieldToScheduler(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('WorkspacePathIndexAdmission', () => {
  it('refuses a one-million-path build reservation above the per-root budget', () => {
    const admission = new WorkspacePathIndexAdmission()
    expect(admission.reserveBuild('root-1m', 517_371_700)).toEqual({
      admitted: false,
      reason: 'root-budget'
    })
  })

  it('separates the per-root retained reservation from honest host build peak', () => {
    const admission = new WorkspacePathIndexAdmission(256, 512)
    const first = admission.reserveBuild('root-spill', 256, 480)
    expect(first.admitted).toBe(true)
    if (!first.admitted) {
      return
    }
    expect(first.reservation).toMatchObject({ bytes: 256, peakBytes: 480 })
    expect(admission.publish(first.reservation, 50)).toBe(true)
    expect(admission.reserveBuild('root-next', 256, 480)).toEqual({
      admitted: false,
      reason: 'over-budget'
    })
    expect(admission.retainedBytes).toBe(50)
  })

  it('counts the old generation and replacement reservation against the host peak', () => {
    const admission = new WorkspacePathIndexAdmission(400, 500)
    const first = admission.reserveBuild('root-a', 200)
    expect(first.admitted).toBe(true)
    if (!first.admitted) {
      return
    }
    expect(admission.publish(first.reservation, 150)).toBe(true)
    expect(admission.reserveBuild('root-a', 351)).toEqual({
      admitted: false,
      reason: 'over-budget'
    })
  })
})

describe('WorkspacePathIndexQueryScheduler', () => {
  it('replaces queued work per consumer and bounds pending consumers', async () => {
    const running = deferred<string>()
    const calls: string[] = []
    const scheduler = new WorkspacePathIndexQueryScheduler<string, string>(
      async (request) => {
        calls.push(request)
        return request === 'first' ? running.promise : request
      },
      () => undefined,
      2
    )
    const first = scheduler.submit('a', 'first')
    await yieldToScheduler()
    const replaced = scheduler.submit('b', 'old')
    const latest = scheduler.submit('b', 'latest')
    const other = scheduler.submit('c', 'other')
    const overflow = scheduler.submit('d', 'overflow')
    await expect(overflow).rejects.toThrow('scheduler is full')
    await expect(replaced).resolves.toBeNull()
    running.resolve('done')
    await expect(first).resolves.toBe('done')
    await expect(latest).resolves.toBe('latest')
    await expect(other).resolves.toBe('other')
    expect(calls).toEqual(['first', 'latest', 'other'])
    expect(scheduler.pendingConsumerCount).toBe(0)
  })

  it('cancels only the superseded consumer and continues with the latest request', async () => {
    const cancelled: string[] = []
    const scheduler = new WorkspacePathIndexQueryScheduler<string, string>(
      async (request, token) => {
        if (request === 'slow') {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return token.isCancelled() ? 'cancelled' : 'slow'
        }
        return request
      },
      (consumer) => cancelled.push(consumer)
    )
    const slow = scheduler.submit('one', 'slow')
    await yieldToScheduler()
    const latest = scheduler.submit('one', 'latest')
    const other = scheduler.submit('two', 'other')
    await expect(slow).resolves.toBeNull()
    await expect(latest).resolves.toBe('latest')
    await expect(other).resolves.toBe('other')
    expect(cancelled).toEqual(['one'])
  })
})
