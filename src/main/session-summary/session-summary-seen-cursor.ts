// The reader's place in the timeline, as the close RPC still reports it.
//
// Kept as a small module rather than a service method because no view reads it any more: the
// pane's window is computed from the transcript's own message indexes (see
// docs/reference/session-summary.md), and this remains for older peers whose close RPC carries
// a count.
import type { SessionSummaryStore } from './session-summary-store'

/**
 * Records how far the reader got; the cursor never moves backwards.
 *
 * @param hostOwnsCursor a paired-host pane's cursor lives on that host, which received the
 *   close itself — recording it here as well would describe a cache this side does not own.
 */
export function recordSessionSummarySeenCursor(args: {
  store: SessionSummaryStore
  paneKey: string
  seenTimelineCount: number
  hostOwnsCursor: boolean
  now: number
}): void {
  if (args.hostOwnsCursor) {
    return
  }
  const stored = args.store.get(args.paneKey)
  if (!stored) {
    return
  }
  const seenThrough = Math.max(
    stored.seenThrough,
    Math.min(Math.max(0, Math.floor(args.seenTimelineCount)), stored.ledger.timeline.length)
  )
  if (seenThrough === stored.seenThrough) {
    return
  }
  args.store.set(args.paneKey, { ...stored, seenThrough, updatedAt: args.now })
}
