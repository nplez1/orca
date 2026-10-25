// Whether a stored brief already answers a re-open, so no fold should start.
//
// Pure and apart from the service because the rule has two independent halves — "young enough"
// and "the agent has not moved since" — and the second one is the stronger of the two: a session
// the agent has not touched is current at any age, while a busy one is stale within minutes.
import type { SessionSummaryStatusEntry } from './session-summary-snapshot'

/**
 * @param revalidateWithinMs the caller's freshness window; 0 or undefined means "always fold"
 *   (the refresh button), which is cheap when nothing is new — a fold with no new events never
 *   reaches the model.
 */
export function isStoredBriefReusable(args: {
  revalidateWithinMs: number | undefined
  foldedAt: number | null | undefined
  /** The identity the stored brief must describe; a different conversation is never reusable. */
  identity?: { providerSessionId: string | null; transcriptPath: string | null }
  entry: SessionSummaryStatusEntry | undefined
  now: number
}): boolean {
  const within = args.revalidateWithinMs ?? 0
  if (within <= 0) {
    return false
  }
  const foldedAt = args.foldedAt
  if (foldedAt === null || foldedAt === undefined) {
    return false
  }
  if (
    args.identity &&
    args.identity.providerSessionId !== null &&
    args.entry?.providerSession?.id &&
    args.identity.providerSessionId !== args.entry.providerSession.id
  ) {
    return false
  }
  const agentUpdatedAt = args.entry?.updatedAt
  // Why require a positive stamp: a row that is gone says nothing, and treating "unknown" as
  // "nothing happened" would reuse a brief forever for a session that resumed later.
  if (agentUpdatedAt !== undefined && agentUpdatedAt > 0 && agentUpdatedAt <= foldedAt) {
    return true
  }
  return args.now - foldedAt <= within
}
