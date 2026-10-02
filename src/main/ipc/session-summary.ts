import { BrowserWindow, ipcMain } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentHookServer } from '../agent-hooks/server'
import type { SessionSummarySnapshot } from '../../shared/session-summary-types'
import {
  isSessionSummaryCloseRequest,
  isSessionSummaryOpenRequest
} from '../../shared/session-summary-types'
import { createAgentCliSessionFoldBrain } from '../session-summary/session-summary-agent-cli-fold-brain'
import { SessionSummaryService } from '../session-summary/session-summary-service'
import { SessionSummaryStore } from '../session-summary/session-summary-store'
import { readSessionSummaryTranscriptEvents } from '../session-summary/session-summary-transcript-source'

export function createSessionSummaryService(): SessionSummaryService {
  return new SessionSummaryService({
    store: SessionSummaryStore.fromUserData(),
    readEvents: readSessionSummaryTranscriptEvents,
    getAgentStatusEntry: (paneKey) =>
      agentHookServer.getStatusSnapshot().find((entry) => entry.paneKey === paneKey),
    createBrain: (params) =>
      createAgentCliSessionFoldBrain({
        resolveParams: () => params,
        // Folds carry their context in the prompt; the CLI never needs a repo cwd.
        cwd: join(tmpdir(), 'orca-session-summary')
      }),
    now: () => Date.now()
  })
}

export function registerSessionSummaryHandlers(service = createSessionSummaryService()): void {
  ipcMain.removeHandler('sessionSummary:open')
  ipcMain.removeHandler('sessionSummary:close')
  service.onUpdate((snapshot: SessionSummarySnapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('sessionSummary:update', snapshot)
      }
    }
  })
  ipcMain.handle('sessionSummary:open', (_event, request: unknown): SessionSummarySnapshot => {
    if (!isSessionSummaryOpenRequest(request)) {
      throw new Error('invalid session summary request')
    }
    return service.open(request)
  })
  ipcMain.on('sessionSummary:close', (_event, request: unknown): void => {
    if (isSessionSummaryCloseRequest(request)) {
      service.close(request)
    }
  })
}
