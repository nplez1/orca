// Electron's coarse window-level hang signal, recorded into the opt-in UI-hang log.
// `unresponsive` fires after roughly 30s of a renderer not answering; `responsive` pairs with it
// and is where the recovered duration comes from. Gated on the setting at event time so the
// Debug Options toggle works live without recreating the window.
//
// Listener lifetime follows the window: like every other observer installed in createMainWindow,
// these die with the window and are not explicitly removed.

import type { UiHangSurface } from '../../shared/ui-hang-diagnostics-types'
import { recordMainUiHangSample } from '../diagnostics/ui-hang-log-sink'

/** Only the setting this observer reads, so tests can supply a stub store. */
export type UiHangSettingsSource = {
  getSettings(): { uiHangDiagnosticsEnabled?: boolean }
}

/** The slice of BrowserWindow this observer needs, so tests can drive it without Electron. */
export type UiHangObservableWindow = {
  on(event: 'unresponsive' | 'responsive', listener: () => void): unknown
  isDestroyed(): boolean
  isVisible(): boolean
}

export function installUiHangWindowObserver(options: {
  window: UiHangObservableWindow
  store: UiHangSettingsSource | null
  surface: UiHangSurface
  now?: () => number
}): void {
  const { window, store, surface } = options
  const now = options.now ?? ((): number => performance.now())
  const isEnabled = (): boolean =>
    store !== null && store.getSettings().uiHangDiagnosticsEnabled === true
  let unresponsiveAtMs: number | null = null

  const onUnresponsive = (): void => {
    if (!isEnabled() || unresponsiveAtMs !== null) {
      return
    }
    unresponsiveAtMs = now()
    recordMainUiHangSample({
      signal: 'window-unresponsive',
      // Electron reports no duration here; the paired `responsive` record carries it.
      durationMs: 0,
      surface,
      visible: !window.isDestroyed() && window.isVisible(),
      capturedAtMs: unresponsiveAtMs
    })
  }

  const onResponsive = (): void => {
    const startedAt = unresponsiveAtMs
    unresponsiveAtMs = null
    if (!isEnabled() || startedAt === null) {
      return
    }
    const capturedAtMs = now()
    recordMainUiHangSample({
      signal: 'window-responsive',
      durationMs: Math.max(0, capturedAtMs - startedAt),
      surface,
      visible: !window.isDestroyed() && window.isVisible(),
      capturedAtMs
    })
  }

  window.on('unresponsive', onUnresponsive)
  window.on('responsive', onResponsive)
}
