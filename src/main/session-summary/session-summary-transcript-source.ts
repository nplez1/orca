// Reads a session's provider transcript (the agent CLI's own JSONL) into
// ordered fold events. Preferred source per docs/reference/session-summary.md;
// structured journal and PTY fallbacks are later adapters over the same events.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentType } from '../../shared/agent-status-types'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { isAiVaultAgent } from '../../shared/ai-vault-types'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session/lifecycle/agent-session-resume'
import {
  resolveNativeChatTranscriptAgent,
  type NativeChatTranscriptAgent
} from '../../shared/native-chat/native-chat-agent-support'
import { readResumableTranscript, readWholeTranscript } from '../ai-vault/session-transcript-reader'
import {
  registerTranscriptConsumer,
  type TranscriptMessage
} from '../ai-vault/session-transcript-consumers'
import { resumableStateFactoryFor } from '../ai-vault/session-scanner-parse-cache'
import { describeSkippedTranscriptRecords } from '../ai-vault/session-transcript-record-budget'
import type { SkippedTranscriptRecord } from '../ai-vault/session-transcript-record-budget'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { COPILOT_SESSIONS_DIR } from '../ai-vault/session-scanner-agent-sources'
import type { SessionFileCandidate, FileWithMtime } from '../ai-vault/session-scanner-types'
import { REMOTE_TRANSCRIPT_MAX_BYTES } from './session-summary-remote-transcript'
import {
  createSessionSummaryEventDigester,
  type SessionSummarySourceEvent
} from './session-summary-event-digest'

/**
 * Retained message text at which the read reports its budget, rather than refusing.
 *
 * Why it no longer gates: the ceiling existed to bound the event array, and the array was only
 * large because raw tool output was retained in it. Tool events are now one-line digests, so the
 * same session allocates a fraction of what it did — and a session that still exceeds the budget
 * gets a summary of everything instead of an error. The number stays as a diagnostic.
 */
export const LOCAL_TRANSCRIPT_MAX_RETAINED_BYTES = REMOTE_TRANSCRIPT_MAX_BYTES

// Why a counter and not the path: two folds of one session carry the same path, and the consumer
// registry is process-wide, so only a per-read tag can tell this fold's messages from a sibling's.
let transcriptReadSequence = 0

export type SessionSummaryEventRead = {
  /** Events from the transcript, starting at the index the caller asked for. */
  events: SessionSummarySourceEvent[]
  /** Every event the transcript holds, including the ones the caller asked us to skip. */
  totalEvents: number
  /** Retained event text, reported against `LOCAL_TRANSCRIPT_MAX_RETAINED_BYTES`. */
  retainedBytes: number
  /**
   * The retained text passed the caller's budget.
   *
   * A diagnostic, not a verdict: the fold proceeds either way, and this is what lets a caller (and
   * a test) say a session is bigger than the budget the read was configured with.
   */
  overRetainedBudget: boolean
  /**
   * Parts of the transcript the reader could not decode, each placed where it belongs.
   *
   * `afterEventIndex` is the number of messages read when the record was skipped, so the gap sits
   * between that message and the next one. Never events: a skipped record has no message index, and
   * inventing one would renumber every fact's provenance.
   */
  gaps: SessionSummaryTranscriptGap[]
}

export type SessionSummaryTranscriptGap = {
  afterEventIndex: number
  text: string
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
  /** The retained-text budget the read reports against; tests use a few bytes. */
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

  // Collect decoded messages via the parser's fan-out; the tag, not the path, scopes the fold to this
  // read, so a concurrent fold of the same session cannot enlist this consumer.
  const readToken = `summary-fold:${++transcriptReadSequence}`
  const collected: SessionSummarySourceEvent[] = []
  const gaps: SessionSummaryTranscriptGap[] = []
  const skipped: { afterEventIndex: number; record: SkippedTranscriptRecord }[] = []
  let received = 0
  let retainedBytes = 0
  // Why a controller of our own: a throw out of the consumer is swallowed by the channel, so a
  // failure here has to stop the read by other means.
  const readController = new AbortController()
  const abortRead = (): void => readController.abort(signal.reason)
  if (signal.aborted) {
    readController.abort(signal.reason)
  }
  signal.addEventListener('abort', abortRead, { once: true })
  const unregister = registerTranscriptConsumer({
    beginRead(start) {
      if (start.readToken !== readToken) {
        return null
      }
      // Why per-read state: a document-format parser that replaces an array mid-read restarts the
      // stream through this same consumer, and state hoisted out of here would count that restart's
      // messages on top of the ones it had already received.
      const digester = createSessionSummaryEventDigester()
      let read = 0
      return {
        message(message: TranscriptMessage) {
          read += 1
          received += 1
          // Why count before the cursor instead of collecting it: the ledger already covers these
          // messages, and their text is what made every fold re-read the whole conversation. The
          // digester still sees them, because a tool result after the cursor belongs to a call
          // before it.
          if (read <= skipEvents) {
            digester.skip(message)
            return
          }
          const event = digester.digest(message)
          retainedBytes += Buffer.byteLength(event.text, 'utf-8')
          collected.push(event)
        },
        finish() {}
      }
    }
  })
  try {
    // Why the resumable path where one exists: it is the same decoder the AI Vault scanner uses, so
    // the message stream is identical, and it applies the per-record budget — a single 500 MB JSONL
    // line used to be read whole into one string here.
    const stateFactory = resumableStateFactoryFor(candidate)
    const onSkippedRecord = (record: SkippedTranscriptRecord): void => {
      skipped.push({ afterEventIndex: received, record })
    }
    const reading = stateFactory
      ? readResumableTranscript({
          candidate,
          platform: process.platform,
          resume: null,
          stateFactory,
          signal: readController.signal,
          readToken,
          onSkippedRecord,
          // A fold has no cursor to keep: it re-reads the file every time, and the last message of a
          // transcript an agent is still writing is usually unterminated.
          includeTrailingPartialLine: true
        })
      : readWholeTranscript({
          candidate,
          platform: process.platform,
          signal: readController.signal,
          readToken
        })
    await reading
    for (const entry of skipped) {
      // Why rebased: `received` counts messages from the start of the file, while the fold places a
      // gap inside a slice that begins at the cursor. A gap before the cursor was already named by
      // the fold that read it, and the ledger keeps it.
      const afterEventIndex = entry.afterEventIndex - skipEvents
      const text = describeSkippedTranscriptRecords([entry.record])
      if (text && afterEventIndex >= 0) {
        gaps.push({ afterEventIndex, text })
      }
    }
    return {
      events: collected,
      totalEvents: received,
      retainedBytes,
      overRetainedBudget: retainedBytes > maxRetainedBytes,
      gaps
    }
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
