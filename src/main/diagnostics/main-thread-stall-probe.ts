// Main-process counterpart of the renderer UI-hang probe, sharing one stall-detection
// implementation so the two records are comparable. A blocked main event loop freezes IPC,
// terminal input, and window management even while the renderer keeps painting, so it belongs
// in the same log.
//
// Main stalls also carry subprocess-spawn attribution: the git runners already measure how long
// each spawn's synchronous initiation held the main thread, so a stall names the spawns that
// caused it instead of only its duration.
//
// Independent of `main-thread-churn-probe.ts`, which aggregates stalls to stderr under
// ORCA_MAIN_THREAD_DIAGNOSTICS and is not controlled by the user setting. The two lanes share
// that file's spawn collector; running both at once splits attribution between them.

import { createStallDetector } from '../../shared/stall-detector'
import {
  drainSubprocessSpawnStats,
  setSubprocessSpawnAttributionEnabled,
  type SubprocessSpawnStats
} from './main-thread-churn-probe'
import { recordMainUiHangSample } from './ui-hang-log-sink'

export const MAIN_THREAD_STALL_TICK_MS = 500
export const MAIN_THREAD_STALL_THRESHOLD_MS = 250

export type MainThreadStallProbeOptions = {
  /** Read live so the Debug Options toggle applies without a restart. */
  isEnabled: () => boolean
  /** Subscribe to settings changes; returns an unsubscribe. Drives start/stop. */
  subscribe: (listener: () => void) => () => void
  isVisible?: () => boolean
  now?: () => number
  wallNow?: () => number
  tickMs?: number
  stallThresholdMs?: number
  /** Injectable for tests; defaults to the shared main-process spawn collector. */
  drainSpawns?: () => Record<string, SubprocessSpawnStats>
}

/** Installs a setting-gated main-thread stall probe. Returns a disposer. */
export function installMainThreadStallProbe(options: MainThreadStallProbeOptions): () => void {
  const tickMs = options.tickMs ?? MAIN_THREAD_STALL_TICK_MS
  const isVisible = options.isVisible ?? ((): boolean => true)
  const drainSpawns = options.drainSpawns ?? drainSubprocessSpawnStats
  let stopInterval: (() => void) | null = null

  const stop = (): void => {
    if (!stopInterval) {
      return
    }
    stopInterval()
    stopInterval = null
    setSubprocessSpawnAttributionEnabled(false)
  }

  const sync = (): void => {
    if (!options.isEnabled()) {
      stop()
      return
    }
    if (stopInterval) {
      return
    }
    setSubprocessSpawnAttributionEnabled(true)
    // Why a fresh detector per start: a stopped interval accumulates an unbounded gap, and the
    // first tick after re-enabling would otherwise be logged as one huge fake stall.
    let drainedSpawns: Record<string, SubprocessSpawnStats> = {}
    const detector = createStallDetector({
      tickMs,
      stallThresholdMs: options.stallThresholdMs ?? MAIN_THREAD_STALL_THRESHOLD_MS,
      now: options.now ?? ((): number => performance.now()),
      wallNow: options.wallNow ?? ((): number => Date.now()),
      onStall: (durationMs, capturedAtMs) => {
        try {
          recordMainUiHangSample({
            signal: 'main-stall',
            durationMs,
            surface: 'main',
            visible: isVisible(),
            capturedAtMs,
            // Why non-empty only: an empty attribution object would read as "measured nothing"
            // rather than "no spawns in this window".
            ...(Object.keys(drainedSpawns).length > 0 ? { spawns: drainedSpawns } : {})
          })
        } catch {
          // Best-effort telemetry.
        }
      }
    })
    // Why drain every tick, not only on a stall: the blocking code prevents this callback from
    // running, so the drain that lands right after the stall covers exactly the blocked window
    // (plus at most one healthy tick), and nothing accumulates unbounded between stalls.
    const tick = (): void => {
      drainedSpawns = drainSpawns()
      detector.tick()
    }
    const timer = setInterval(tick, tickMs)
    timer.unref?.()
    stopInterval = () => clearInterval(timer)
  }

  sync()
  const unsubscribe = options.subscribe(sync)
  return () => {
    unsubscribe()
    stop()
  }
}
