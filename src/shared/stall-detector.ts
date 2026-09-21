// Shared stall math for the opt-in UI-hang log, used by both the renderer probe and the
// main-process probe. A timer that fires late by N ms proves that thread was blocked for N ms.
//
// Why one implementation: the renderer and main process measure the same phenomenon on
// different event loops, and a divergence between the two detectors would make their records
// impossible to compare.

export type StallDetectorConfig = {
  tickMs: number
  /** Ignore gaps below this; sustained small gaps are jank, not a hang worth logging. */
  stallThresholdMs: number
  /** Monotonic clock (`performance.now()`), which may exclude system sleep. */
  now: () => number
  /** Wall clock (`Date.now()`), which always advances through system sleep. */
  wallNow: () => number
  onStall: (durationMs: number, capturedAtMs: number) => void
}

export type StallDetector = {
  /** Call from the interval callback. Never throws. */
  tick: () => void
}

// Why: a wall-clock jump far ahead of the monotonic clock is sleep/resume, not a hang.
const CLOCK_DIVERGENCE_SLACK_MS = 2_000

export function createStallDetector(config: StallDetectorConfig): StallDetector {
  let lastMonotonic = config.now()
  let lastWall = config.wallNow()
  return {
    tick: () => {
      const tickMonotonic = config.now()
      const tickWall = config.wallNow()
      const monotonicGapMs = tickMonotonic - lastMonotonic
      const wallGapMs = tickWall - lastWall
      lastMonotonic = tickMonotonic
      lastWall = tickWall
      if (wallGapMs - monotonicGapMs > CLOCK_DIVERGENCE_SLACK_MS) {
        return
      }
      const stallMs = monotonicGapMs - config.tickMs
      if (stallMs < config.stallThresholdMs) {
        return
      }
      config.onStall(stallMs, tickMonotonic)
    }
  }
}
