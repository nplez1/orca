import { ipcRenderer } from 'electron'
import type {
  SessionSummaryAskRequest,
  SessionSummaryCloseRequest,
  SessionSummaryOpenRequest,
  SessionSummarySnapshot
} from '../../shared/session-summary-types'
import type { PreloadApi } from '../api-types'

export const sessionSummaryApi = {
  open: (request: SessionSummaryOpenRequest): Promise<SessionSummarySnapshot> =>
    ipcRenderer.invoke('sessionSummary:open', request),
  close: (request: SessionSummaryCloseRequest): void => {
    ipcRenderer.send('sessionSummary:close', request)
  },
  ask: (request: SessionSummaryAskRequest): Promise<SessionSummarySnapshot> =>
    ipcRenderer.invoke('sessionSummary:ask', request),
  onUpdate: (callback: (snapshot: SessionSummarySnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: SessionSummarySnapshot) =>
      callback(snapshot)
    ipcRenderer.on('sessionSummary:update', listener)
    return () => ipcRenderer.removeListener('sessionSummary:update', listener)
  }
} satisfies PreloadApi['sessionSummary']
