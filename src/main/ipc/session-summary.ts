import { BrowserWindow, ipcMain } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { agentHookServer } from '../agent-hooks/server'
import type { SessionSummarySnapshot } from '../../shared/session-summary-types'
import {
  isSessionSummaryCloseRequest,
  isSessionSummaryOpenRequest
} from '../../shared/session-summary-types'
import { callRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'
import { getSshConnectionManager } from '../ssh/targets/ssh-target-registry'
import { createAgentCliSessionFoldBrain } from '../session-summary/session-summary-agent-cli-fold-brain'
import { createSessionSummaryEventReader } from '../session-summary/session-summary-event-reader'
import {
  createSessionSummaryHostFoldClient,
  type SessionSummaryHostFoldClient
} from '../session-summary/session-summary-host-fold-client'
import { registerHostSessionSummaryService } from '../session-summary/session-summary-host-service'
import { createSshTranscriptFetcher } from '../session-summary/session-summary-remote-transcript'
import {
  resolveSessionSummaryFoldParams,
  type SessionSummaryFoldSettings
} from '../session-summary/session-summary-fold-params'
import { canReadAgentTranscript } from '../session-summary/session-summary-transcript-source'
import { SessionSummaryService } from '../session-summary/session-summary-service'
import { SessionSummaryStore } from '../session-summary/session-summary-store'
import type { SessionSummaryEventReaderDeps } from '../session-summary/session-summary-event-reader'

export type SessionSummaryServiceOverrides = {
  userDataPath?: string
  /** Injected by tests: reading a transcript off an SSH host needs a live connection. */
  sshTranscript?: SessionSummaryEventReaderDeps['fetchSshTranscript']
  /** Injected by tests: folds that run on a paired host need a reachable server. */
  hostFold?: SessionSummaryHostFoldClient
}

export function createSessionSummaryService(
  getSettings: () => SessionSummaryFoldSettings,
  overrides: SessionSummaryServiceOverrides = {}
): SessionSummaryService {
  const userDataPath = overrides.userDataPath ?? getAppEnvironment().getPath('userData')
  return new SessionSummaryService({
    store: new SessionSummaryStore(join(userDataPath, 'session-summaries.json')),
    readEvents: createSessionSummaryEventReader({
      fetchSshTranscript: overrides.sshTranscript ?? sshTranscriptFetcher()
    }),
    getAgentStatusEntry: (paneKey) =>
      agentHookServer.getStatusSnapshot().find((entry) => entry.paneKey === paneKey),
    canReadTranscript: canReadAgentTranscript,
    createBrain: (params) =>
      createAgentCliSessionFoldBrain({
        // Request params are an explicit override; the user's text-generation
        // settings are the normal source.
        resolveParams: () => params ?? resolveSessionSummaryFoldParams(getSettings()),
        // Folds carry their context in the prompt; the CLI never needs a repo cwd.
        cwd: join(tmpdir(), 'orca-session-summary')
      }),
    hostFold: overrides.hostFold ?? runtimeHostFoldClient(userDataPath),
    // The host fold spawns the agent on that host, so this window's choice travels with it.
    resolveFoldParams: () => resolveSessionSummaryFoldParams(getSettings()),
    now: () => Date.now()
  })
}

/** Reads a transcript off an SSH target over the connection Orca already holds. */
function sshTranscriptFetcher(): SessionSummaryEventReaderDeps['fetchSshTranscript'] {
  return createSshTranscriptFetcher({
    openChannel: async ({ targetId, command, signal }) => {
      const connection = getSshConnectionManager()?.getConnection(targetId)
      if (!connection) {
        // Why not 'unavailable': the session exists and its host is known — this client
        // is simply not connected, which is a failure the reader can retry.
        throw new Error(`Not connected to ${targetId}`)
      }
      return await connection.exec(command, { signal })
    }
  })
}

/** Subscribes to a fold that runs on the paired host owning the session. */
function runtimeHostFoldClient(userDataPath: string): SessionSummaryHostFoldClient {
  return createSessionSummaryHostFoldClient({
    call: async (environmentId, method, params) => {
      const response = await callRuntimeEnvironment(userDataPath, environmentId, method, params)
      if (response.ok === true) {
        return response.result
      }
      // Why re-thrown with its code: the client tells "this host has no such method"
      // (an out-of-date server) from a fold that failed for its own reasons.
      throw Object.assign(new Error(response.error.message), { code: response.error.code })
    }
  })
}

export function registerSessionSummaryHandlers(
  getSettings: () => SessionSummaryFoldSettings,
  service = createSessionSummaryService(getSettings)
): void {
  // One service per process: a paired client asking this desktop to fold a pane must land
  // on the same instance its own windows use, not a second copy of the cache.
  registerHostSessionSummaryService(service)
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
