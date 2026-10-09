import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearCommentComposerFocusTimer,
  scheduleCommentComposerFocusTimer,
  type CommentComposerFocusTimerRef
} from './comment-composer-focus-timer'

function createTimerRef(): CommentComposerFocusTimerRef {
  return { current: null }
}

describe('comment composer focus timers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears pending deferred focus work', () => {
    vi.useFakeTimers()
    const timerRef = createTimerRef()
    const callback = vi.fn()

    scheduleCommentComposerFocusTimer(timerRef, callback)
    clearCommentComposerFocusTimer(timerRef)
    vi.runOnlyPendingTimers()

    expect(timerRef.current).toBeNull()
    expect(callback).not.toHaveBeenCalled()
  })

  it('replaces stale deferred focus work', () => {
    vi.useFakeTimers()
    const timerRef = createTimerRef()
    const staleCallback = vi.fn()
    const nextCallback = vi.fn()

    scheduleCommentComposerFocusTimer(timerRef, staleCallback)
    scheduleCommentComposerFocusTimer(timerRef, nextCallback)
    vi.runOnlyPendingTimers()

    expect(staleCallback).not.toHaveBeenCalled()
    expect(nextCallback).toHaveBeenCalledTimes(1)
    expect(timerRef.current).toBeNull()
  })
})
