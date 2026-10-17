import type { AiVaultListSyncDelta, AiVaultSession } from './ai-vault-types'
import { sortAiVaultSessionsByRecency } from './ai-vault-session-sort'

/**
 * Rebuilds the list a client holds from the changes a host reported. Rows are keyed by the served
 * id (host-stamped and parent-restamped ids agree by construction), so an upsert replaces in place
 * and the order comes from the rows themselves rather than from the delta.
 */
export function applyAiVaultListDelta(
  held: readonly AiVaultSession[],
  delta: AiVaultListSyncDelta
): AiVaultSession[] {
  const byId = new Map<string, AiVaultSession>()
  for (const session of held) {
    byId.set(session.id, session)
  }
  for (const session of delta.upserts) {
    byId.set(session.id, session)
  }
  for (const id of delta.removedIds) {
    byId.delete(id)
  }
  return sortAiVaultSessionsByRecency([...byId.values()])
}
