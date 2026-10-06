// Reads a session's provider transcript (the agent CLI's own JSONL) into
// ordered fold events. Preferred source per docs/reference/session-summary.md;
// structured journal and PTY fallbacks are later adapters over the same events.
import { stat } from 'node:fs/promises'
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
  const transcriptAgent = resolveNativeChatTranscriptAgent(agentType)
  if (!transcriptAgent) {
    return null
  }
  const filePath = await resolveSessionFilePath(
    agentType,
    providerSession.id,
    providerSession.transcriptPath ? { transcriptPath: providerSession.transcriptPath } : {},
    signal
  )
  if (!filePath) {
    return null
  }
  const stats = await stat(filePath)
  const file: FileWithMtime = {
    path: filePath,
    mtimeMs: stats.mtimeMs,
    modifiedAt: stats.mtime.toISOString(),
    sizeBytes: stats.size
  }
  const candidate: SessionFileCandidate = {
    agent: CANDIDATE_AGENTS[transcriptAgent],
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
