// Reads a session's provider transcript (the agent CLI's own JSONL) into
// ordered fold events. Preferred source per docs/reference/session-summary.md;
// structured journal and PTY fallbacks are later adapters over the same events.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentType } from '../../shared/agent-status-types'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { isAiVaultAgent } from '../../shared/ai-vault-types'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import {
  resolveNativeChatTranscriptAgent,
  type NativeChatTranscriptAgent
} from '../../shared/native-chat-agent-support'
import { readWholeTranscript } from '../ai-vault/session-transcript-reader'
import {
  registerTranscriptConsumer,
  type TranscriptMessage
} from '../ai-vault/session-transcript-consumers'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { COPILOT_SESSIONS_DIR } from '../ai-vault/session-scanner-agent-sources'
import type { SessionFileCandidate, FileWithMtime } from '../ai-vault/session-scanner-types'
import { REMOTE_TRANSCRIPT_MAX_BYTES } from './session-summary-remote-transcript'
import type { SessionSummarySourceEvent } from './session-summary-fold'

/**
 * Fold ceiling in retained message text, not transcript bytes.
 *
 * Why text and not file size: the fold's parsers stream line by line and events before the ledger's
 * cursor are counted rather than kept, so what this bounds is the event array the fold holds in the
 * main process — the allocation a 500 MB transcript with inline base64 images used to exhaust. A
 * file-size cap would instead refuse long sessions that now fold fine.
 */
export const LOCAL_TRANSCRIPT_MAX_RETAINED_BYTES = REMOTE_TRANSCRIPT_MAX_BYTES

export type SessionSummaryEventRead = {
  /** Events from the transcript, starting at the index the caller asked for. */
  events: SessionSummarySourceEvent[]
  /** Every event the transcript holds, including the ones the caller asked us to skip. */
  totalEvents: number
}

// Compile-checked: every transcript agent must name a real AI Vault agent.
const CANDIDATE_AGENTS: Record<NativeChatTranscriptAgent, AiVaultAgent> = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
  omp: 'omp',
  opencode: 'opencode'
}

/**
 * The parser for an agent that reported its own transcript path.
 *
 * Any agent AI Vault can decode qualifies: the hook named a file this process can open, so
 * the only question left is which decoder reads it. An allowlist here was the reason every
 * agent outside the native-chat set reported "no readable transcript" even when its hook
 * handed over the path — the parsers existed, the dispatch did not.
 */
function resolveHookPathParser(agentType: AgentType): AiVaultAgent | null {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agentType)
  if (transcriptAgent) {
    return CANDIDATE_AGENTS[transcriptAgent]
  }
  // Why: OpenClaude writes the Claude transcript format and layout.
  if (agentType === 'openclaude') {
    return 'claude'
  }
  return isAiVaultAgent(agentType) ? agentType : null
}

/** Copilot's own id shape; anything else must not be joined onto a root path. */
const COPILOT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export type SessionSummarySessionIdentity = {
  agentType?: AgentType
  providerSession?: AgentProviderSessionMetadata
}

/** Null when this session has no readable provider transcript (yet). */
export async function readSessionSummaryTranscriptEvents(args: {
  identity: SessionSummarySessionIdentity
  signal: AbortSignal
  /** Events before this index are already folded: their text is counted, never retained. */
  fromEventIndex?: number
}): Promise<SessionSummaryEventRead | null> {
  const { identity, signal } = args
  const providerSession = identity.providerSession
  const agentType = identity.agentType
  if (!providerSession?.id || !agentType) {
    return null
  }
  const source = await resolveTranscriptSource(agentType, providerSession, signal)
  if (!source) {
    return null
  }
  return readSessionSummaryEventsFromFile({
    filePath: source.path,
    parser: source.parser,
    signal,
    fromEventIndex: args.fromEventIndex
  })
}

/**
 * The parser that decodes an agent's transcript by content alone.
 *
 * Used when the file is not on this machine: the remote path comes from that host's
 * own hook, so no root search applies, and Copilot's synthesized session directory
 * is skipped because the remote home directory is not knowable here.
 */
/**
 * Whether this build can decode that agent's transcript at all.
 *
 * Asked when a fold finds nothing, so the pane can say "we cannot read this agent" instead of
 * claiming to have searched for a file that a format this build does not implement would be
 * in.
 */
export function canReadAgentTranscript(agentType: AgentType): boolean {
  return resolveHookPathParser(agentType) !== null
}

export function resolveRemoteTranscriptParser(agentType: AgentType): AiVaultAgent | null {
  const parser = resolveHookPathParser(agentType)
  // Why copilot is excluded: with no hook path it is located by joining the session id
  // onto this machine's sessions root, which is not the remote host's root.
  return parser && parser !== 'copilot' ? parser : null
}

/** Decode one transcript file into ordered fold events. */
export async function readSessionSummaryEventsFromFile(args: {
  filePath: string
  parser: AiVaultAgent
  signal: AbortSignal
  fromEventIndex?: number
  /** Overrides the fold ceiling; tests use a few bytes instead of 24 MB. */
  maxRetainedBytes?: number
}): Promise<SessionSummaryEventRead | null> {
  const { filePath, parser, signal } = args
  const skipEvents = Math.max(0, args.fromEventIndex ?? 0)
  const maxRetainedBytes = args.maxRetainedBytes ?? LOCAL_TRANSCRIPT_MAX_RETAINED_BYTES
  const stats = await stat(filePath)
  if (!stats.isFile()) {
    return null
  }
  const file: FileWithMtime = {
    path: filePath,
    mtimeMs: stats.mtimeMs,
    modifiedAt: stats.mtime.toISOString(),
    sizeBytes: stats.size
  }
  const candidate: SessionFileCandidate = {
    agent: parser,
    file,
    codexHome: null
  }

  // Collect decoded messages via the parser's fan-out; scoped to this path so a
  // concurrent AI Vault scan of another file can't leak into the fold.
  const collected: TranscriptMessage[] = []
  let received = 0
  let retainedBytes = 0
  let retainedOverflow: Error | null = null
  // Why a controller of our own: the ceiling has to stop the read, and a throw out of the consumer
  // is swallowed by the channel so a faulty sink can never break a parse.
  const readController = new AbortController()
  const abortRead = (): void => readController.abort(signal.reason)
  if (signal.aborted) {
    readController.abort(signal.reason)
  }
  signal.addEventListener('abort', abortRead, { once: true })
  const unregister = registerTranscriptConsumer({
    beginRead(start) {
      if (start.candidate.file.path !== filePath) {
        return null
      }
      return {
        message(message) {
          if (retainedOverflow) {
            return
          }
          received += 1
          // Why count before the cursor instead of collecting it: the ledger already covers these
          // messages, and their text is what made every fold re-read the whole conversation.
          if (received <= skipEvents) {
            return
          }
          retainedBytes += Buffer.byteLength(message.text, 'utf-8')
          if (retainedBytes > maxRetainedBytes) {
            // Why fail instead of folding what fits: a shortened transcript renumbers every event,
            // and the ledger's cursor would then point at messages this fold never saw.
            retainedOverflow = new Error(
              `This session has over ${Math.max(
                1,
                Math.round(maxRetainedBytes / (1024 * 1024))
              )} MB of unfolded messages, which is too much to fold in one pass.`
            )
            readController.abort(retainedOverflow)
            return
          }
          collected.push(message)
        },
        finish() {}
      }
    }
  })
  try {
    await readWholeTranscript({
      candidate,
      platform: process.platform,
      signal: readController.signal
    })
    if (retainedOverflow) {
      throw retainedOverflow
    }
    return {
      events: collected.map((message) => ({
        role: message.role,
        text: message.text,
        timestamp: message.timestamp
      })),
      totalEvents: received
    }
  } catch (error) {
    throw retainedOverflow ?? error
  } finally {
    signal.removeEventListener('abort', abortRead)
    unregister()
  }
}

/**
 * The transcript file to fold and the AI Vault parser that decodes it.
 *
 * Native-chat agents keep the native-chat resolver, which owns the hook-path
 * handoff, Claude/Codex profile roots and WSL host translation. Agents outside
 * that set are only locatable by the path their own hook reports, or — Copilot —
 * by the session id its hook names a directory with.
 */
async function resolveTranscriptSource(
  agentType: AgentType,
  providerSession: AgentProviderSessionMetadata,
  signal: AbortSignal
): Promise<{ path: string; parser: AiVaultAgent } | null> {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agentType)
  if (transcriptAgent) {
    const path = await resolveSessionFilePath(
      agentType,
      providerSession.id,
      providerSession.transcriptPath ? { transcriptPath: providerSession.transcriptPath } : {},
      signal
    )
    return path ? { path, parser: CANDIDATE_AGENTS[transcriptAgent] } : null
  }

  const parser = resolveHookPathParser(agentType)
  if (!parser) {
    return null
  }
  // A hook-named file is the exact artifact the CLI is writing. Copilot's hook
  // carries no path at all, so its session id names the directory instead.
  const hookPath = providerSession.transcriptPath?.trim()
  if (hookPath && (await isReadableFile(hookPath))) {
    return { path: hookPath, parser }
  }
  return agentType === 'copilot' ? copilotTranscriptSource(providerSession.id) : null
}

function copilotTranscriptSource(sessionId: string): { path: string; parser: AiVaultAgent } | null {
  if (!COPILOT_SESSION_ID_PATTERN.test(sessionId)) {
    return null
  }
  return { path: join(COPILOT_SESSIONS_DIR, sessionId, 'events.jsonl'), parser: 'copilot' }
}

/** A path the hook named is only usable when this host can actually open it. */
async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
