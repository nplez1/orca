// How one fold's result reaches the store.
//
// Apart from the runner because it is the half that has to be careful: a write here is what a later
// fold resumes from, and two rules in it are load-bearing — an empty ledger must never be recorded
// (it reads as "Up to date" over a blank body, #135), and a chunk cache with no ledger must be
// recorded anyway (it is a first fold in progress, and dropping it restarts the fold at event 0).
import { emptySessionSummaryLedger, hasProducedLedger } from './session-summary-ledger'
import type {
  SessionSummaryChunkCache,
  SessionSummaryChunkFailureTracker
} from './session-summary-fold'
import type { SessionSummaryStoreEntry } from './session-summary-store'
import type { SessionSummaryFoldRunnerDeps } from './session-summary-fold-runner'

export function storedEntry(
  deps: SessionSummaryFoldRunnerDeps,
  paneKey: string,
  identity: SessionSummaryStoreEntry['identity']
): SessionSummaryStoreEntry {
  return deps.store.get(paneKey) ?? freshStoreEntry(identity, deps.now())
}

/**
 * The persisted failure counts for a pane's slices.
 *
 * Why it lives beside the cache: both are folded-in-progress state, both are pruned by the same
 * rule, and both are worthless once the cursor passes the range they describe.
 */
export function chunkFailuresFor(
  stored: SessionSummaryStoreEntry
): SessionSummaryChunkFailureTracker {
  const counts = (stored.chunkFailures ??= {})
  return {
    record: (key) => {
      const next = (counts[key] ?? 0) + 1
      counts[key] = next
      return next
    },
    clear: (key) => {
      delete counts[key]
    }
  }
}

export function chunkCacheFor(stored: SessionSummaryStoreEntry): SessionSummaryChunkCache {
  return {
    get: (key) => stored.chunkCache[key],
    set: (key, delta) => {
      stored.chunkCache[key] = delta
    }
  }
}

export function persist(
  deps: SessionSummaryFoldRunnerDeps,
  paneKey: string,
  identity: SessionSummaryStoreEntry['identity'],
  stored: SessionSummaryStoreEntry,
  messageCount: number
): void {
  // Chunk extracts covered by the new foldedThrough are already applied; drop them.
  const chunkCache: SessionSummaryStoreEntry['chunkCache'] = {}
  for (const [key, delta] of Object.entries(stored.chunkCache)) {
    const from = Number.parseInt(key.split('-')[0] ?? '', 10)
    if (Number.isFinite(from) && from >= stored.ledger.foldedThrough) {
      chunkCache[key] = delta
    }
  }
  // Why: nothing folded yet means there is no summary to remember, and recording an empty ledger
  // is what made the next visit claim "Up to date" over a blank body (#135). A chunk cache with no
  // ledger is the opposite case — a first fold in progress — and keeping it is what lets an
  // interrupted fold resume instead of restarting at event 0.
  if (!hasProducedLedger(stored.ledger) && Object.keys(chunkCache).length === 0) {
    return
  }
  // Why pruned like the cache: a slice the cursor has passed will never be retried, so its count is
  // dead weight in a file that holds two hundred panes.
  const chunkFailures: Record<string, number> = {}
  for (const [key, count] of Object.entries(stored.chunkFailures ?? {})) {
    const from = Number.parseInt(key.split('-')[0] ?? '', 10)
    if (Number.isFinite(from) && from >= stored.ledger.foldedThrough) {
      chunkFailures[key] = count
    }
  }
  deps.store.set(paneKey, {
    identity,
    ledger: stored.ledger,
    chunkCache,
    chunkFailures,
    messageCount,
    seenThrough: stored.seenThrough,
    updatedAt: deps.now()
  })
}

export function freshStoreEntry(
  identity: SessionSummaryStoreEntry['identity'],
  now: number
): SessionSummaryStoreEntry {
  return {
    identity,
    ledger: emptySessionSummaryLedger(),
    chunkCache: {},
    messageCount: 0,
    seenThrough: 0,
    updatedAt: now
  }
}
