import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HIDDEN_EXIT_DRAIN_GRACE_MS,
  STALLED_DEADLINE_OVERRUN_MS,
  deadlineOverrunMetadata,
  deadlineOverrunOf,
  recordDeadlineOverrunOnSpan,
  terminateAtStalledDeadline
} from './stalled-deadline-kill'

describe('terminateAtStalledDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('kills on the spot when the deadline fired on time and nothing exited', () => {
    // Why no turn here: an on-time deadline leaves no backlog, and every caller's own deadlines
    // hang off this instant.
    const terminate = vi.fn()
    terminateAtStalledDeadline({
      overrunMs: STALLED_DEADLINE_OVERRUN_MS - 1,
      isSettled: () => false,
      hasExited: () => false,
      terminate
    })
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  it('holds the kill below the threshold once the child has exited', async () => {
    // Why below the threshold: the lateness only says the timer fired late. Whether the exit was
    // already observed is what decides the kill, so a short stall must not kill a finished command.
    const terminate = vi.fn()
    terminateAtStalledDeadline({
      overrunMs: STALLED_DEADLINE_OVERRUN_MS - 1,
      isSettled: () => false,
      hasExited: () => true,
      terminate
    })
    expect(terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(terminate).not.toHaveBeenCalled()
  })

  it('gives a late deadline a drain window before killing', async () => {
    const terminate = vi.fn()
    terminateAtStalledDeadline({
      overrunMs: 387_550,
      isSettled: () => false,
      hasExited: () => false,
      terminate
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HIDDEN_EXIT_DRAIN_GRACE_MS - 1)
    expect(terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    // The drain checks for a settled child one turn later, after the poll phase.
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  it('leaves a command alone when the drain delivers it', async () => {
    const terminate = vi.fn()
    let settled = false
    terminateAtStalledDeadline({
      overrunMs: 387_550,
      isSettled: () => settled,
      hasExited: () => false,
      terminate
    })
    settled = true
    await vi.advanceTimersByTimeAsync(HIDDEN_EXIT_DRAIN_GRACE_MS)
    expect(terminate).not.toHaveBeenCalled()
  })
})

describe('deadline overrun metadata', () => {
  it('tags only a deadline that fired late', () => {
    expect(deadlineOverrunMetadata(STALLED_DEADLINE_OVERRUN_MS - 1)).toEqual({})
    expect(deadlineOverrunMetadata(387_550.6)).toEqual({ deadlineOverrunMs: 387_551 })
  })

  it('reads the tag back off an error', () => {
    const error = Object.assign(new Error('git timed out.'), deadlineOverrunMetadata(387_550))
    expect(deadlineOverrunOf(error)).toBe(387_550)
    expect(deadlineOverrunOf(new Error('git timed out.'))).toBeNull()
    expect(deadlineOverrunOf('git timed out.')).toBeNull()
  })

  it('records the tag on the git.exec span', () => {
    const span = {
      traceId: 'trace',
      spanId: 'span',
      setAttribute: vi.fn(),
      addEvent: vi.fn(),
      fail: vi.fn(),
      interrupt: vi.fn(),
      end: vi.fn()
    }
    recordDeadlineOverrunOnSpan(
      span,
      Object.assign(new Error('git timed out.'), deadlineOverrunMetadata(387_550))
    )
    expect(span.setAttribute.mock.calls).toEqual([['git.deadline_overrun_ms', 387_550]])
    recordDeadlineOverrunOnSpan(span, new Error('git timed out.'))
    expect(span.setAttribute).toHaveBeenCalledTimes(1)
  })
})
