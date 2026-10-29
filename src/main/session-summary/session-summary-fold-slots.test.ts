import { afterEach, describe, expect, it } from 'vitest'
import {
  SESSION_SUMMARY_CONCURRENT_FOLDS,
  resetSessionSummaryFoldSlotsForTests,
  withSessionSummaryFoldSlot
} from './session-summary-fold-slots'

/** Why: one fold per open pane means the process-wide total, not the per-fold total, is the bound. */

afterEach(() => {
  resetSessionSummaryFoldSlotsForTests()
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const signal = (): AbortSignal => new AbortController().signal

describe('withSessionSummaryFoldSlot', () => {
  it('admits only the fold limit, then hands a release to the waiter', async () => {
    const entered: string[] = []
    const gates = Array.from({ length: SESSION_SUMMARY_CONCURRENT_FOLDS }, deferred)
    const running = gates.map((gate, index) =>
      withSessionSummaryFoldSlot(signal(), async () => {
        entered.push(`fold-${index}`)
        await gate.promise
      })
    )
    await Promise.resolve()

    const waiterGate = deferred()
    const waiting = withSessionSummaryFoldSlot(signal(), async () => {
      entered.push('waiter')
      await waiterGate.promise
    })
    await Promise.resolve()
    expect(entered).toHaveLength(SESSION_SUMMARY_CONCURRENT_FOLDS)

    gates[0]?.resolve()
    await running[0]
    await Promise.resolve()
    expect(entered).toEqual(['fold-0', 'fold-1', 'waiter'])

    waiterGate.resolve()
    gates[1]?.resolve()
    await Promise.all([...running, waiting])
  })

  it('rejects a waiter whose fold is aborted instead of granting it later', async () => {
    const entered: string[] = []
    const gates = Array.from({ length: SESSION_SUMMARY_CONCURRENT_FOLDS }, deferred)
    const running = gates.map((gate, index) =>
      withSessionSummaryFoldSlot(signal(), async () => {
        entered.push(`fold-${index}`)
        await gate.promise
      })
    )
    await Promise.resolve()

    const controller = new AbortController()
    const waiting = withSessionSummaryFoldSlot(controller.signal, async () => {
      entered.push('aborted')
    })
    controller.abort(new Error('pane closed'))

    await expect(waiting).rejects.toThrow('pane closed')
    // The aborted waiter must not consume the slot the next release frees.
    const next = withSessionSummaryFoldSlot(signal(), async () => {
      entered.push('next')
    })
    gates[0]?.resolve()
    await next
    expect(entered).toContain('next')

    gates[1]?.resolve()
    await Promise.all(running)
  })

  it('refuses a slot to an already aborted caller', async () => {
    await expect(
      withSessionSummaryFoldSlot(
        AbortSignal.abort(new Error('already gone')),
        async () => undefined
      )
    ).rejects.toThrow('already gone')
  })

  it('releases the slot when the fold body throws', async () => {
    await expect(
      withSessionSummaryFoldSlot(signal(), async () => {
        throw new Error('chunk failed')
      })
    ).rejects.toThrow('chunk failed')

    // Every slot must be free again: the limit only works if a failure gives its slot back.
    const entered: number[] = []
    const gates = Array.from({ length: SESSION_SUMMARY_CONCURRENT_FOLDS }, deferred)
    const running = gates.map((gate, index) =>
      withSessionSummaryFoldSlot(signal(), async () => {
        entered.push(index)
        await gate.promise
      })
    )
    await Promise.resolve()
    expect(entered).toHaveLength(SESSION_SUMMARY_CONCURRENT_FOLDS)

    for (const gate of gates) {
      gate.resolve()
    }
    await Promise.all(running)
  })
})
