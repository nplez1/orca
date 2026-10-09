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

export function nestAiVaultSubagentSessions(
  sessions: readonly AiVaultSession[]
): AiVaultSubagentNesting {
  const byKey = new Map<string, AiVaultSession>()
  for (const session of sessions) {
    byKey.set(aiVaultSubagentParentKey(session), session)
  }

  const childrenByParentId = new Map<string, AiVaultSession[]>()
  const roots: AiVaultSession[] = []
  let hiddenChildCount = 0

  for (const session of sessions) {
    const parentSessionId = session.subagent?.parentSessionId
    if (!parentSessionId) {
      roots.push(session)
      continue
    }
    const parentKey = aiVaultSubagentParentKey({ ...session, sessionId: parentSessionId })
    const parent = byKey.get(parentKey)
    // Hidden when the parent is missing from this list, or when the ancestry
    // loops: two transcripts naming each other have no reachable top row, and
    // nesting them would give the list an unbounded expand chain.
    if (!parent || !reachesRoot(parent, byKey)) {
      hiddenChildCount += 1
      continue
    }
    const siblings = childrenByParentId.get(parentKey)
    if (siblings) {
      siblings.push(session)
    } else {
      childrenByParentId.set(parentKey, [session])
    }
  }

  return { roots, childrenByParentId, hiddenChildCount }
}

function reachesRoot(session: AiVaultSession, byKey: ReadonlyMap<string, AiVaultSession>): boolean {
  const seen = new Set<string>([aiVaultSubagentParentKey(session)])
  let current: AiVaultSession | undefined = session
  while (current) {
    const parentSessionId = current.subagent?.parentSessionId
    if (!parentSessionId) {
      return true
    }
    const parentKey = aiVaultSubagentParentKey({ ...current, sessionId: parentSessionId })
    if (seen.has(parentKey)) {
      return false
    }
    seen.add(parentKey)
    current = byKey.get(parentKey)
  }
  return false
}
