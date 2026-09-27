import type {
  UiHangLifecycleEvent,
  UiHangOperation
} from '../../../../shared/ui-hang-diagnostics-types'
import { useAppStore } from '../../store'

const MIN_OPERATION_LOG_INTERVAL_MS = 1_000
const lastLoggedAtMs = new Map<UiHangOperation, number>()

/** Record bounded focus/resume work only while the user has opted into UI-hang logging. */
export function recordUiHangLifecycleEvent(event: UiHangLifecycleEvent): void {
  try {
    if (useAppStore.getState().settings?.uiHangDiagnosticsEnabled !== true) {
      return
    }
    const record = window.api?.uiHangDiagnostics?.record
    if (!record) {
      return
    }
    record({
      signal: 'lifecycle',
      lifecycleEvent: event,
      durationMs: 0,
      surface: 'main',
      visible: document.visibilityState === 'visible',
      capturedAtMs: performance.now(),
      capturedAtWallMs: Date.now()
    })
  } catch {
    // Diagnostics must never interfere with window lifecycle handlers.
  }
}

export function recordUiHangOperation(operation: UiHangOperation, startedAtMs: number): void {
  try {
    if (useAppStore.getState().settings?.uiHangDiagnosticsEnabled !== true) {
      return
    }
    const record = window.api?.uiHangDiagnostics?.record
    if (!record) {
      return
    }
    const capturedAtMs = performance.now()
    const lastLoggedAt = lastLoggedAtMs.get(operation)
    if (lastLoggedAt !== undefined && capturedAtMs - lastLoggedAt < MIN_OPERATION_LOG_INTERVAL_MS) {
      return
    }
    lastLoggedAtMs.set(operation, capturedAtMs)
    record({
      signal: 'handler',
      operation,
      durationMs: Math.max(0, capturedAtMs - startedAtMs),
      surface: 'main',
      visible: document.visibilityState === 'visible',
      capturedAtMs,
      capturedAtWallMs: Date.now()
    })
  } catch {
    // Diagnostics must never interfere with focus recovery.
  }
}
