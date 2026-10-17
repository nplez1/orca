import type { AiVaultSession } from './ai-vault-types'

/** The instant a listing orders by: when the session last changed. */
export function aiVaultSessionSortTime(
  session: Pick<AiVaultSession, 'updatedAt' | 'modifiedAt'>
): number {
  return Date.parse(session.updatedAt ?? session.modifiedAt)
}

/**
 * Newest first, with `id` breaking ties. A synced client rebuilds its order from the rows it ends
 * up holding, so it needs a total order of its own — not the position a delta happened to arrive in.
 */
export function sortAiVaultSessionsByRecency<
  T extends Pick<AiVaultSession, 'id' | 'updatedAt' | 'modifiedAt'>
>(sessions: readonly T[]): T[] {
  return [...sessions].sort((left, right) => {
    const leftTime = aiVaultSessionSortTime(left)
    const rightTime = aiVaultSessionSortTime(right)
    const byTime =
      (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime)
    if (byTime !== 0) {
      return byTime
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}
