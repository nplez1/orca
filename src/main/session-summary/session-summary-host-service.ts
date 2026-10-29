// The summary service as a *host* runs it, for sessions that live on this machine.
//
// Electron-free on purpose: a paired Orca server (`orcad`) serves the same methods with
// no Electron app, so this module reaches user data and status rows only through the
// app-environment shim and the hook server. See docs/reference/session-summary.md.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isCustomAgentId } from '../../shared/commit-message-agent-spec'
import { agentHookServer } from '../agent-hooks/server'
import { createAgentCliSessionFoldBrain } from './session-summary-agent-cli-fold-brain'
import { SessionSummaryService } from './session-summary-service'
import { SessionSummaryStore } from './session-summary-store'
import {
  canReadAgentTranscript,
  readSessionSummaryTranscriptEvents
} from './session-summary-transcript-source'

const FOLD_PARAMS_STRING_FIELDS = [
  'thinkingLevel',
  'customPrompt',
  'commandInputTemplate',
  'agentArgs',
  'customAgentCommand',
  'agentCommandOverride'
] as const

/**
 * Narrow wire params into the fold configuration the brain reads.
 *
 * Checked rather than cast: these arrive from another process, and an agent id this
 * build does not know must fail the fold instead of being trusted into a spawn.
 */
export function parseSessionSummaryFoldParams(
  value: unknown
): ResolvedSourceControlAiGenerationParams | null {
  if (!isRecord(value)) {
    return null
  }
  const record = value
  const agentId = record.agentId
  if (typeof agentId !== 'string' || (!isTuiAgent(agentId) && !isCustomAgentId(agentId))) {
    return null
  }
  if (typeof record.model !== 'string') {
    return null
  }
  const params: ResolvedSourceControlAiGenerationParams = { agentId, model: record.model }
  for (const field of FOLD_PARAMS_STRING_FIELDS) {
    const fieldValue = record[field]
    if (typeof fieldValue === 'string' && fieldValue) {
      params[field] = fieldValue
    }
  }
  return params
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

let registered: SessionSummaryService | null = null
let cached: { userDataPath: string; service: SessionSummaryService } | null = null

/**
 * Adopts the service this process already runs for its own windows.
 *
 * Why: a desktop is also a paired host (`main-process-runtime-launch.ts` serves the same
 * methods), and two services would keep separate in-memory copies of the one
 * `session-summaries.json` and rewrite each other's edits, while folding the same pane
 * twice. Registering the IPC instance keeps one owner per process.
 */
export function registerHostSessionSummaryService(service: SessionSummaryService): void {
  registered = service
}

/** This host's summary service: the registered one, or a headless host's own. */
export function sessionSummaryHostService(): SessionSummaryService {
  if (registered) {
    return registered
  }
  const userDataPath = getAppEnvironment().getPath('userData')
  if (cached?.userDataPath === userDataPath) {
    return cached.service
  }
  const service = new SessionSummaryService({
    store: new SessionSummaryStore(join(userDataPath, 'session-summaries.json')),
    // The transcript is on this machine: this is the local half of the fold.
    readEvents: ({ identity, signal, fromEventIndex }) =>
      readSessionSummaryTranscriptEvents({ identity, signal, fromEventIndex }),
    getAgentStatusEntry: (paneKey) =>
      agentHookServer.getStatusSnapshot().find((entry) => entry.paneKey === paneKey),
    canReadTranscript: canReadAgentTranscript,
    createBrain: (params) =>
      createAgentCliSessionFoldBrain({
        // Why no settings fallback: the client that opened this pane resolved the agent
        // and model from its own settings and sent them. Falling back to *this* host's
        // settings would spawn an agent the reader never chose for a session's own text.
        resolveParams: () => params,
        cwd: join(tmpdir(), 'orca-session-summary')
      }),
    now: () => Date.now()
  })
  cached = { userDataPath, service }
  return service
}
