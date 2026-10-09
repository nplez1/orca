import type { AiVaultSessionSubagentInfo } from '../../shared/ai-vault-types'
import type { SessionAccumulator } from './session-scanner-types'
import { asRecord, extractString, sessionIdFromFileName } from './session-scanner-values'

/**
 * How a Pi-family transcript declares that it is a sub-agent rather than a
 * session a person opened.
 *
 * The `parentSession` header field alone is NOT that signal. Pi writes it for
 * ordinary user sessions too — auto-compaction and "resume in another
 * directory" hand the previous file to the new one (pi `session-manager.js`
 * `parentSession: previousSessionFile` / `parentSession: resolvedSourcePath`),
 * and Pi's own picker nests every one of them. Nesting those would hide the
 * live continuation of a conversation under the file it superseded.
 *
 * So a transcript also has to declare a sub-agent identity, which the
 * spawning extension does twice: `session.setSessionName("<name>#<id8>")` and
 * an `<active_agent name="…"/>` tag in the system preamble. Older runs
 * persisted only the name, so either marker is enough. Both are conventions
 * rather than Pi guarantees: if they change, sub-agent rows reappear at top
 * level, which is the safe direction to fail — never a hidden real session.
 */
// The suffix is the spawner's agent id, sliced to 8. Ids are UUID-derived hex
// today, but the workflow lane also passes crafted ids, so accept a wider
// alphabet than hex rather than miss a whole spawning path.
const SUBAGENT_SESSION_NAME_PATTERN = /^(.+)#[0-9a-zA-Z_-]{8}$/
const ACTIVE_AGENT_TAG_PATTERN = /<active_agent\s+name="([^"]+)"/i

/** Agent type from a `session_info` name like `Explore#06356862`, else null. */
export function subagentAgentTypeFromSessionName(name: unknown): string | null {
  const match = typeof name === 'string' ? SUBAGENT_SESSION_NAME_PATTERN.exec(name.trim()) : null
  return match?.[1]?.trim() || null
}

/** Agent type from a system preamble carrying `<active_agent name="…"/>`, else null. */
export function subagentAgentTypeFromPreamble(preamble: unknown): string | null {
  const match = typeof preamble === 'string' ? ACTIVE_AGENT_TAG_PATTERN.exec(preamble) : null
  return match?.[1]?.trim() || null
}

/**
 * Reads the declaration out of one message-graph record. Every record goes
 * through here because the markers arrive as three different record types.
 */
export function consumeSubagentDeclarationRecord(
  accumulator: SessionAccumulator,
  record: Record<string, unknown>
): void {
  if (record.type === 'session') {
    const parentSessionPath = extractString(record.parentSession)
    if (parentSessionPath) {
      accumulator.lineageParentSessionPath = parentSessionPath
    }
    return
  }
  if (record.type === 'session_info') {
    // Only the startup naming counts: a rename later in the conversation is a
    // person's, and matching it would nest their own session.
    if (accumulator.declaredSubagentAgentType === null && accumulator.messageCount === 0) {
      accumulator.declaredSubagentAgentType = subagentAgentTypeFromSessionName(record.name)
    }
    return
  }
  if (record.type !== 'message' || accumulator.declaredSubagentAgentType !== null) {
    return
  }
  const message = asRecord(record.message)
  if (extractString(message?.role) === 'system') {
    accumulator.declaredSubagentAgentType = subagentAgentTypeFromPreamble(
      asRecord(message?.sections)?.preamble
    )
  }
}

/** A scanned row's parent link, or null when the transcript is a root session. */
export function scannedSubagentInfo(
  accumulator: SessionAccumulator,
  sessionId: string
): AiVaultSessionSubagentInfo | null {
  const parentSessionPath = accumulator.lineageParentSessionPath
  const agentType = accumulator.declaredSubagentAgentType
  if (!parentSessionPath || !agentType) {
    return null
  }
  const parentSessionId = sessionIdFromFileName(parentSessionPath)
  // Self-reference is dropped rather than trusted: a transcript naming itself
  // as its own parent would otherwise hide the session behind a row that can
  // never be expanded.
  if (parentSessionId === sessionId) {
    return null
  }
  // Status is Claude/OMP-only (read from the parent's task records); a scanned
  // sub-agent transcript carries no equivalent.
  return { parentSessionId, agentType, status: null }
}
