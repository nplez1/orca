import type { AiVaultSession } from './ai-vault-types'

/**
 * Splits a filtered session list into parent rows plus the sub-agent rows that
 * belong under each one. Pure and renderer-free so desktop and mobile share it.
 *
 * Rows the list cannot nest are counted rather than dropped quietly: a parent
 * that fell outside the loaded window (or outside the active agent/scope
 * filter) is not in the list, and hiding those children is a deliberate
 * choice, so the count is what the UI reports back.
 */
export type AiVaultSubagentNesting = {
  /** Rows to render at top level; sub-agent rows are not among them. */
  roots: readonly AiVaultSession[]
  /** Sub-agent rows per parent, in the order the parent's list arrived. */
  childrenByParentId: ReadonlyMap<string, readonly AiVaultSession[]>
  /** Sub-agent rows whose parent is not renderable in this list. */
  hiddenChildCount: number
}

/**
 * Identity a child's `parentSessionId` resolves against. Agent and host are
 * part of the key because a session id is only unique inside its own store —
 * Claude and Pi both write bare uuids.
 */
export function aiVaultSubagentParentKey(
  session: Pick<AiVaultSession, 'executionHostId' | 'agent' | 'sessionId'>
): string {
  return `${session.executionHostId}\u0000${session.agent}\u0000${session.sessionId}`
}

/** One row per key, plus every row that shares a host and a session id — the second index is what
 *  lets a child name a parent from a DIFFERENT agent. */
type SessionIndex = {
  byKey: ReadonlyMap<string, AiVaultSession>
  byHostSessionId: ReadonlyMap<string, readonly AiVaultSession[]>
}

function indexSessions(sessions: readonly AiVaultSession[]): SessionIndex {
  const byKey = new Map<string, AiVaultSession>()
  const byHostSessionId = new Map<string, AiVaultSession[]>()
  for (const session of sessions) {
    byKey.set(aiVaultSubagentParentKey(session), session)
    const hostKey = `${session.executionHostId}\u0000${session.sessionId}`
    const sameHost = byHostSessionId.get(hostKey)
    if (sameHost) {
      sameHost.push(session)
    } else {
      byHostSessionId.set(hostKey, [session])
    }
  }
  return { byKey, byHostSessionId }
}

/**
 * The row a session's `parentSessionId` names, and the key it is filed under.
 *
 * The child's own agent and host are tried first, because that is the unambiguous reading and the
 * only one an id alone cannot get wrong. A parent of a DIFFERENT agent is the second reading: a
 * Claude conversation spawned by a pi session names that pi session, and no row of the child's own
 * agent carries the id. It is accepted only when exactly one row on the host has it — an id two
 * agents share must stay unresolved, not pick one.
 */
function resolveParent(
  session: AiVaultSession,
  parentSessionId: string,
  index: SessionIndex
): { key: string; session: AiVaultSession } | null {
  const sameAgentKey = aiVaultSubagentParentKey({ ...session, sessionId: parentSessionId })
  const direct = index.byKey.get(sameAgentKey)
  if (direct) {
    return { key: sameAgentKey, session: direct }
  }
  const candidates = (
    index.byHostSessionId.get(`${session.executionHostId}\u0000${parentSessionId}`) ?? []
  ).filter((candidate) => candidate.agent !== session.agent)
  if (candidates.length !== 1) {
    return null
  }
  const parent = candidates[0]
  return { key: aiVaultSubagentParentKey(parent), session: parent }
}

export function nestAiVaultSubagentSessions(
  sessions: readonly AiVaultSession[]
): AiVaultSubagentNesting {
  const index = indexSessions(sessions)
  const childrenByParentId = new Map<string, AiVaultSession[]>()
  const roots: AiVaultSession[] = []
  let hiddenChildCount = 0

  for (const session of sessions) {
    const parentSessionId = session.subagent?.parentSessionId
    if (!parentSessionId) {
      roots.push(session)
      continue
    }
    const parent = resolveParent(session, parentSessionId, index)
    if (!parent) {
      // Why shown rather than hidden when the link crosses agents: such a link is recorded by a
      // marker, and its parent can be missing from THIS list simply because the list is filtered to
      // the child's agent. Counting it hidden would make those conversations vanish from a
      // Claude-only view, which is where a person goes looking for them.
      if (isCrossAgentLink(session)) {
        roots.push(session)
        continue
      }
      hiddenChildCount += 1
      continue
    }
    // Hidden when the ancestry loops: two transcripts naming each other have no reachable top row,
    // and nesting them would give the list an unbounded expand chain.
    if (!reachesRoot(parent.session, index)) {
      hiddenChildCount += 1
      continue
    }
    const siblings = childrenByParentId.get(parent.key)
    if (siblings) {
      siblings.push(session)
    } else {
      childrenByParentId.set(parent.key, [session])
    }
  }

  return { roots, childrenByParentId, hiddenChildCount }
}

/** A parent link that names another agent than the child's own, so its absence is not evidence the
 *  parent is unloaded. */
function isCrossAgentLink(session: AiVaultSession): boolean {
  const parentAgent = session.subagent?.parentAgent
  return parentAgent !== undefined && parentAgent !== session.agent
}

function reachesRoot(session: AiVaultSession, index: SessionIndex): boolean {
  const seen = new Set<string>([aiVaultSubagentParentKey(session)])
  let current: AiVaultSession | undefined = session
  while (current) {
    const parentSessionId = current.subagent?.parentSessionId
    if (!parentSessionId) {
      return true
    }
    const parent = resolveParent(current, parentSessionId, index)
    if (!parent || seen.has(parent.key)) {
      return false
    }
    seen.add(parent.key)
    current = parent.session
  }
  return false
}
