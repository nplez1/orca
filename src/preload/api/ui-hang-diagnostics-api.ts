import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { UiHangDiagnosticsStatus, UiHangSample } from '../../shared/ui-hang-diagnostics-types'

export type UiHangDiagnosticsApi = {
  /** Fire-and-forget sample; main decides whether the setting + consent allow a write. */
  record: (sample: UiHangSample) => void
  getStatus: () => Promise<UiHangDiagnosticsStatus>
}

export const uiHangDiagnosticsApi = {
  record: (sample: UiHangSample): void => {
    ipcRenderer.send('uiHangDiagnostics:record', sample)
  },
  getStatus: (): Promise<UiHangDiagnosticsStatus> =>
    ipcRenderer.invoke('uiHangDiagnostics:getStatus')
} satisfies PreloadApi['uiHangDiagnostics']
