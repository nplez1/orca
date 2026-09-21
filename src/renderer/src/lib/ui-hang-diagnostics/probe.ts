// Renderer UI-thread stall detector for the opt-in UI-hang log.
//
// Why an interval watchdog: a timer that fires late by N ms proves the UI thread was blocked
// for N ms, and unlike `longtask` it also captures aggregate blocking across several short
// tasks. Each stall is sent immediately — batching would delay the record with the very timer
// the stall just delayed.

import { createStallDetector } from '../../../../shared/stall-detector'
import type { UiHangSample, UiHangSurface } from '../../../../shared/ui-hang-diagnostics-types'

export const UI_HANG_TICK_MS = 500
export const UI_HANG_STALL_THRESHOLD_MS = 250

export type UiHangProbeOptions = {
  send: (sample: UiHangSample) => void
  surface?: UiHangSurface
  /** Injectable for tests. */
  now?: () => number
  wallNow?: () => number
  visible?: () => boolean
}

export type UiHangProbe = { stop: () => void }

export function startUiHangProbe(options: UiHangProbeOptions): UiHangProbe {
  const visible = options.visible ?? ((): boolean => document.visibilityState === 'visible')
  const surface = options.surface ?? 'main'
  const detector = createStallDetector({
    tickMs: UI_HANG_TICK_MS,
    stallThresholdMs: UI_HANG_STALL_THRESHOLD_MS,
    now: options.now ?? ((): number => performance.now()),
    wallNow: options.wallNow ?? ((): number => Date.now()),
    onStall: (durationMs, capturedAtMs) => {
      try {
        // Why: the probe must never be the thing that breaks the UI it is measuring.
        options.send({ signal: 'stall', durationMs, surface, visible: visible(), capturedAtMs })
      } catch {
        // Best-effort telemetry.
      }
    }
  })
  const timer = window.setInterval(detector.tick, UI_HANG_TICK_MS)
  return {
    stop: () => window.clearInterval(timer)
  }
}
