// Which session a pane is folding, and whether two answers describe the same conversation.
//
// Pure and apart from the fold because both the desktop and a paired host ask these questions, and
// because getting them wrong briefs the previous conversation: a lagging client id must not override
// a row that names its own session (#135).
import type { AgentProviderSessionMetadata } from '../../shared/agent-session/lifecycle/agent-session-resume'
import type { SessionSummarySessionRef } from '../../shared/session-summary-types'
import type { SessionSummaryStoreEntry } from './session-summary-store'

export function sessionSummaryIdentityOf(
  entry: SessionSummarySessionRef | undefined
): SessionSummaryStoreEntry['identity'] {
  return {
    providerSessionId: entry?.providerSession?.id ?? null,
    transcriptPath: entry?.providerSession?.transcriptPath ?? null
  }
}

/**
 * The identity a fold should use: this process's own row, with the viewer's request filling
 * what the row cannot say.
 *
 * Why the request is a filler and not an override: the viewer is the one process guaranteed
 * to know *which* session the reader is looking at, which is exactly what a paired host or a
 * reconnected client was missing when it answered "no readable transcript" for a live
 * session. But where this process holds a row that names a session, that row is its own
 * latest evidence (hooks land here), and letting a lagging client id override it would brief
 * the previous conversation — the failure #135 is about.
 */
export function mergeSessionRef(
  requested: SessionSummarySessionRef | null | undefined,
  entry: SessionSummarySessionRef | undefined
): SessionSummarySessionRef {
  const chosen = mergeProviderSession(entry?.providerSession, requested?.providerSession)
  // Why paired with its session: an agent type from one side next to a session from the other
  // describes a conversation neither side has — Pi's transcript read with Claude's parser — so
  // the type always comes from whichever side supplied the session.
  const agentType = chosen.fromEntry
    ? (entry?.agentType ?? requested?.agentType)
    : (requested?.agentType ?? entry?.agentType)
  return {
    ...(agentType ? { agentType } : {}),
    ...(chosen.providerSession ? { providerSession: chosen.providerSession } : {})
  }
}

/** The row's session when it names one; its missing transcript path from the request. */
function mergeProviderSession(
  local: AgentProviderSessionMetadata | undefined,
  requested: AgentProviderSessionMetadata | undefined
): { providerSession: AgentProviderSessionMetadata | undefined; fromEntry: boolean } {
  if (!local) {
    return { providerSession: requested, fromEntry: false }
  }
  if (local.transcriptPath || !requested?.transcriptPath || requested.id !== local.id) {
    return { providerSession: local, fromEntry: true }
  }
  return {
    providerSession: { ...local, transcriptPath: requested.transcriptPath },
    fromEntry: true
  }
}

/**
 * Whether two stored identities describe different conversations.
 *
 * A side without a transcript path knows less, it does not know something different: treating a
 * missing path as a change dropped a good ledger and its seen cursor whenever the identity came
 * from a request that named only the session id.
 */
export function sessionSummaryIdentityChanged(
  a: SessionSummaryStoreEntry['identity'],
  b: SessionSummaryStoreEntry['identity']
): boolean {
  if (a.providerSessionId !== b.providerSessionId) {
    return true
  }
  if (!a.transcriptPath || !b.transcriptPath) {
    return false
  }
  return a.transcriptPath !== b.transcriptPath
}

export function hasSessionRef(ref: SessionSummarySessionRef): boolean {
  return Boolean(ref.agentType || ref.providerSession)
}
