import { afterEach, describe, expect, it } from 'vitest'
import {
  SESSION_SUMMARY_CONCURRENT_FOLDS,
  acquireSessionSummaryFoldSlot,
  releaseSessionSummaryFoldSlot,
  resetSessionSummaryFoldSlotsForTests
} from './session-summary-fold-slots'

/** Why: one fold per open pane means the process-wide total, not the per-fold total, is the bound. */

afterEach(() => {
  resetSessionSummaryFoldSlotsForTests()
})

async function holdEverySlot(): Promise<void> {
  for (let index = 0; index < SESSION_SUMMARY_CONCURRENT_FOLDS; index += 1) {
    await acquireSessionSummaryFoldSlot(new AbortController().signal)
  }
}

describe('acquireSessionSummaryFoldSlot', () => {
  it('grants every slot up to the fold limit, then hands a release to the waiter', async () => {
    const granted: string[] = []
    await holdEverySlot()
    const waiting = acquireSessionSummaryFoldSlot(new AbortController().signal).then(() =>
      granted.push('waiter')
    )

    await Promise.resolve()
    expect(granted).toEqual([])

    releaseSessionSummaryFoldSlot()
    await waiting
    expect(granted).toEqual(['waiter'])
  })

  it('rejects a waiter whose fold is aborted instead of granting it later', async () => {
    await holdEverySlot()
    const controller = new AbortController()
    const waiting = acquireSessionSummaryFoldSlot(controller.signal)

    controller.abort(new Error('pane closed'))

    await expect(waiting).rejects.toThrow('pane closed')
    // The aborted waiter must not consume the slot the next release frees.
    const granted = acquireSessionSummaryFoldSlot(new AbortController().signal)
    releaseSessionSummaryFoldSlot()
    await expect(granted).resolves.toBeUndefined()
  })

  it('refuses a slot to an already aborted caller', async () => {
    await expect(
      acquireSessionSummaryFoldSlot(AbortSignal.abort(new Error('already gone')))
    ).rejects.toThrow('already gone')
  })
})
