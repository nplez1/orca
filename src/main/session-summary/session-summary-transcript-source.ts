// Reads a session's provider transcript (the agent CLI's own JSONL) into
// ordered fold events. Preferred source per docs/reference/session-summary.md;
// structured journal and PTY fallbacks are later adapters over the same events.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentType } from '../../shared/agent-status-types'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
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
import type { SessionSummarySourceEvent } from './session-summary-fold'

// Compile-checked: every transcript agent must name a real AI Vault agent.
const CANDIDATE_AGENTS: Record<NativeChatTranscriptAgent, AiVaultAgent> = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
  omp: 'omp',
  opencode: 'opencode'
}

/**
 * Transcript agents outside the native-chat set, which resolves its own paths.
 *
 * Pi and Prime Agent post `session_file` on every hook, so the reported path is
 * the CLI's own artifact. Copilot reports no path at all, but names its session
 * directory after the session id the hook carries.
 */
const HOOK_RESOLVED_TRANSCRIPT_AGENTS: Partial<Record<AgentType, AiVaultAgent>> = {
  pi: 'pi',
  'prime-agent': 'prime-agent',
  copilot: 'copilot'
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
}): Promise<SessionSummarySourceEvent[] | null> {
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
  const filePath = source.path
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
    agent: source.parser,
    file,
    codexHome: null
  }

  // Collect decoded messages via the parser's fan-out; scoped to this path so a
  // concurrent AI Vault scan of another file can't leak into the fold.
  const collected: TranscriptMessage[] = []
  const unregister = registerTranscriptConsumer({
    beginRead(start) {
      if (start.candidate.file.path !== filePath) {
        return null
      }
      return {
        message(message) {
          collected.push(message)
        },
        finish() {}
      }
    }
  })
  try {
    await readWholeTranscript({ candidate, platform: process.platform, signal })
    return collected.map((message) => ({
      role: message.role,
      text: message.text,
      timestamp: message.timestamp
    }))
  } finally {
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

  const parser = HOOK_RESOLVED_TRANSCRIPT_AGENTS[agentType]
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
