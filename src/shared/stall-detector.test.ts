import { describe, expect, it, vi } from 'vitest'
import { createStallDetector } from './stall-detector'

describe('createStallDetector', () => {
  it('reports wall and monotonic bounds for a delayed tick', () => {
    let monotonic = 100
    let wall = 1_000
    const onStall = vi.fn()
    const detector = createStallDetector({
      tickMs: 500,
      stallThresholdMs: 250,
      now: () => monotonic,
      wallNow: () => wall,
      onStall
    })

    monotonic = 900
    wall = 1_800
    detector.tick()

    expect(onStall).toHaveBeenCalledWith(300, 900, {
      monotonicStartedAtMs: 100,
      monotonicEndedAtMs: 900,
      wallStartedAtMs: 1_000,
      wallEndedAtMs: 1_800
    })
  })

  it('does not report a wall-clock gap that substantially exceeds monotonic time', () => {
    let monotonic = 100
    let wall = 1_000
    const onStall = vi.fn()
    const detector = createStallDetector({
      tickMs: 500,
      stallThresholdMs: 250,
      now: () => monotonic,
      wallNow: () => wall,
      onStall
    })

    monotonic = 900
    wall = 10_000
    detector.tick()

    expect(onStall).not.toHaveBeenCalled()
  })
})
