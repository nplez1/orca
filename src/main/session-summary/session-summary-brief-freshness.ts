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
  // Nothing happened since the fold: the brief is current however old it is.
  if ((args.entry?.updatedAt ?? 0) <= foldedAt) {
    return true
  }
  return args.now - foldedAt <= within
}
