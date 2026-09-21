// IPC boundary for the opt-in UI-hang log (Settings → Advanced → Debug Options).
// The renderer may only submit samples while the setting is on; main is the authority for
// both the setting and the log file, exactly like the diagnostics/telemetry lanes.

import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { UiHangDiagnosticsStatus } from '../../shared/ui-hang-diagnostics-types'
import {
  getUiHangDiagnosticsStatus,
  recordRendererUiHangSample
} from '../diagnostics/ui-hang-log-sink'

export function isUiHangLoggingEnabled(store: Store): boolean {
  return store.getSettings().uiHangDiagnosticsEnabled === true
}

export function registerUiHangDiagnosticsHandlers(store: Store): void {
  ipcMain.handle('uiHangDiagnostics:getStatus', (): UiHangDiagnosticsStatus =>
    getUiHangDiagnosticsStatus(isUiHangLoggingEnabled(store))
  )

  // Why `on` and not `handle`: stall samples are fire-and-forget, and a reply the renderer
  // is currently blocked from reading is the one thing this channel must not wait on.
  ipcMain.on('uiHangDiagnostics:record', (_event, sample: unknown) => {
    if (!isUiHangLoggingEnabled(store)) {
      return
    }
    recordRendererUiHangSample(sample)
  })
}
