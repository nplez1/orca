// Whether a stored brief already answers a re-open, so no fold should start.
//
// Pure and apart from the service because the rule has two independent halves — "young enough"
// and "the agent has not moved since" — and the second one is the stronger of the two: a session
// the agent has not touched is current at any age, while a busy one is stale within minutes.
import type { SessionSummaryStatusEntry } from './session-summary-snapshot'
import { mergeSessionRef, sessionSummaryIdentityOf } from './session-summary-fold-runner'
import type { SessionSummaryStoreEntry } from './session-summary-store'
import type {
  SessionSummaryLedger,
  SessionSummarySessionRef
} from '../../shared/session-summary-types'

export type SessionSummaryBriefIdentity = {
  providerSessionId: string | null
  transcriptPath: string | null
}

/**
 * Whether a stored brief may be shown for the session this pane holds now.
 *
 * Why this is its own rule: a pane keeps its key when one agent exits and another starts in the same
 * terminal, so the cached ledger outlives the conversation in it. An absent current id used to pass
 * every check, so the previous session's brief rendered as "ready" for the new one, and stayed that
 * way for an agent that never reports an id.
 *
 * Why an absent id is not on its own a mismatch: this desktop clears its status rows on reconnect, and
 * a cleared row still describes a pane that holds the very session the brief was folded for. What the
 * reconnect story cannot explain is a row that has moved since the fold and still names no session —
 * the pane is running something else and has not said what.
 */
export function storedBriefIsAttributable(args: {
  storedIdentity?: SessionSummaryBriefIdentity
  currentIdentity?: SessionSummaryBriefIdentity
  /** The row's own clock, which is what "the agent did something" means here. */
  agentUpdatedAt?: number
  foldedAt?: number | null
}): boolean {
  const stored = args.storedIdentity?.providerSessionId
  // Nothing claims a session, so nothing can contradict the pane either.
  if (!stored) {
    return true
  }
  const current = args.currentIdentity?.providerSessionId
  if (current) {
    return current === stored
  }
  const moved =
    args.agentUpdatedAt !== undefined &&
    args.agentUpdatedAt > 0 &&
    (args.foldedAt === null || args.foldedAt === undefined || args.agentUpdatedAt > args.foldedAt)
  return !moved
}

/**
 * The stored ledger to serve for a pane, or null when this pane cannot attribute it.
 *
 * Why withheld rather than deleted: the ledger is the cache that keeps the next fold cheap, and a
 * pane's key outlives the agent that was running in it.
 */
export function attributableStoredLedger(
  stored: SessionSummaryStoreEntry | null | undefined,
  entry: SessionSummaryStatusEntry | undefined,
  /** The viewer's own record of the session, which fills in what the row cannot say. */
  requestedIdentity: SessionSummarySessionRef | undefined
): SessionSummaryLedger | null {
  const ledger = stored?.ledger ?? null
  if (!ledger) {
    return null
  }
  const attributable = storedBriefIsAttributable({
    storedIdentity: stored?.identity,
    currentIdentity: sessionSummaryIdentityOf(mergeSessionRef(requestedIdentity, entry)),
    ...(entry?.updatedAt === undefined ? {} : { agentUpdatedAt: entry.updatedAt }),
    foldedAt: ledger.foldedAt ?? null
  })
  return attributable ? ledger : null
}

/**
 * @param revalidateWithinMs the caller's freshness window; 0 or undefined means "always fold"
 *   (the refresh button), which is cheap when nothing is new — a fold with no new events never
 *   reaches the model.
 */
export function isStoredBriefReusable(args: {
  revalidateWithinMs: number | undefined
  foldedAt: number | null | undefined
  /** The session the stored brief describes, and the one being asked about. */
  storedIdentity?: SessionSummaryBriefIdentity
  currentIdentity?: SessionSummaryBriefIdentity
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
  // Why first: an unattributable brief is not a question of freshness, and the age window below
  // cannot rule it out. A needless fold costs no model call when there are no new events.
  if (
    !storedBriefIsAttributable({
      storedIdentity: args.storedIdentity,
      currentIdentity: args.currentIdentity,
      agentUpdatedAt: args.entry?.updatedAt,
      foldedAt
    })
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
