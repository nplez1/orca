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
  // Why decorate: this runs over the whole listing on every page, and a comparator would parse
  // each timestamp once per comparison instead of once per row.
  const decorated = sessions.map((session) => {
    const time = aiVaultSessionSortTime(session)
    return { session, time: Number.isNaN(time) ? 0 : time }
  })
  decorated.sort((left, right) => {
    const byTime = right.time - left.time
    return byTime !== 0
      ? byTime
      : left.session.id < right.session.id
        ? -1
        : left.session.id > right.session.id
          ? 1
          : 0
  })
  return decorated.map((entry) => entry.session)
}
