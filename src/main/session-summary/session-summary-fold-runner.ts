// One fold, end to end: read the transcript, fold it in bounded chunks, persist the result.
//
// Kept out of the service so the service stays the lazy-lifecycle layer (open/close and
// which host folds) while this is the chapter that can fail: a transcript read, a model
// extract, or a write. Nothing is applied on failure, and completed chunk extracts are
// kept so a retry resumes instead of restarting.
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import type {
  SessionSummarySnapshot,
  SessionSummaryStatus
} from '../../shared/session-summary-types'
import { emptySessionSummaryLedger, hasProducedLedger } from './session-summary-ledger'
import {
  foldSessionSummaryEvents,
  type SessionFoldBrain,
  type SessionSummaryChunkCache,
  type SessionSummarySourceEvent
} from './session-summary-fold'
import { IDLE_FOLD, type SessionSummaryStatusEntry } from './session-summary-snapshot'
import type { SessionSummaryStore, SessionSummaryStoreEntry } from './session-summary-store'
import type { SessionSummarySessionIdentity } from './session-summary-transcript-source'
import type { SessionSummaryTranscriptHost } from './session-summary-transcript-host'

export type SessionSummaryFoldRunnerDeps = {
  store: SessionSummaryStore
  readEvents: (args: {
    identity: SessionSummarySessionIdentity
    host: SessionSummaryTranscriptHost
    signal: AbortSignal
  }) => Promise<SessionSummarySourceEvent[] | null>
  getAgentStatusEntry: (paneKey: string) => SessionSummaryStatusEntry | undefined
  createBrain: (params: ResolvedSourceControlAiGenerationParams | null) => SessionFoldBrain
  now: () => number
}

export type SessionSummaryFoldCallbacks = {
  /** Everything a fold reports back: progress, the settled status, and the failure. */
  onStatus: (update: {
    status: SessionSummaryStatus
    fold: SessionSummarySnapshot['fold']
    messageCount?: number
    error?: string
  }) => void
}

export function sessionSummaryIdentityOf(
  entry: SessionSummaryStatusEntry | undefined
): SessionSummaryStoreEntry['identity'] {
  return {
    providerSessionId: entry?.providerSession?.id ?? null,
    transcriptPath: entry?.providerSession?.transcriptPath ?? null
  }
}

/** Fold a pane's new events. Resolves when the fold settles; never throws. */
export async function runSessionSummaryFold(args: {
  deps: SessionSummaryFoldRunnerDeps
  callbacks: SessionSummaryFoldCallbacks
  paneKey: string
  host: SessionSummaryTranscriptHost
  foldParams: ResolvedSourceControlAiGenerationParams | null
  signal: AbortSignal
}): Promise<void> {
  const { deps, callbacks, paneKey, host, signal } = args
  const report = callbacks.onStatus
  try {
    const entry = deps.getAgentStatusEntry(paneKey)
    const identity = sessionSummaryIdentityOf(entry)
    const events = await deps.readEvents({
      identity: {
        ...(entry?.agentType ? { agentType: entry.agentType } : {}),
        ...(entry?.providerSession ? { providerSession: entry.providerSession } : {})
      },
      host,
      signal
    })
    signal.throwIfAborted()
    if (!events) {
      report({ status: 'unavailable', fold: IDLE_FOLD })
      return
    }
    const stored = storedEntry(deps, paneKey, identity)
    const newEvents = events.slice(stored.ledger.foldedThrough)
    if (newEvents.length === 0) {
      // Persist first: the snapshot a listener receives reads the store, so reporting
      // 'ready' before the write showed a ready status over an absent ledger.
      persist(deps, paneKey, identity, stored, events.length)
      report({
        // No readable content yet is 'unavailable', not a summary of nothing.
        status: events.length === 0 ? 'unavailable' : 'ready',
        fold: IDLE_FOLD,
        messageCount: events.length
      })
      return
    }
    const result = await foldSessionSummaryEvents({
      brain: deps.createBrain(args.foldParams),
      ledger: stored.ledger,
      events: newEvents,
      signal,
      cache: chunkCacheFor(stored),
      onProgress: (progress) =>
        report({
          status: 'folding',
          fold: {
            running: true,
            completedChunks: progress.completedChunks,
            totalChunks: progress.totalChunks
          },
          messageCount: events.length
        })
    })
    signal.throwIfAborted()
    persist(deps, paneKey, identity, { ...stored, ledger: result.ledger }, events.length)
    report({
      status: 'ready',
      fold: {
        running: false,
        completedChunks: result.completedChunks,
        totalChunks: result.totalChunks
      },
      messageCount: events.length
    })
  } catch (error) {
    if (signal.aborted) {
      return // Pane closed: cancel-on-close, nothing to report.
    }
    // Completed chunk extracts survive the failure so a retry resumes, not restarts.
    const failedIdentity = sessionSummaryIdentityOf(deps.getAgentStatusEntry(paneKey))
    const failedStored = storedEntry(deps, paneKey, failedIdentity)
    persist(deps, paneKey, failedIdentity, failedStored, failedStored.messageCount)
    report({
      status: 'failed',
      fold: IDLE_FOLD,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function storedEntry(
  deps: SessionSummaryFoldRunnerDeps,
  paneKey: string,
  identity: SessionSummaryStoreEntry['identity']
): SessionSummaryStoreEntry {
  return deps.store.get(paneKey) ?? freshStoreEntry(identity, deps.now())
}

function chunkCacheFor(stored: SessionSummaryStoreEntry): SessionSummaryChunkCache {
  return {
    get: (key) => stored.chunkCache[key],
    set: (key, delta) => {
      stored.chunkCache[key] = delta
    }
  }
}

function persist(
  deps: SessionSummaryFoldRunnerDeps,
  paneKey: string,
  identity: SessionSummaryStoreEntry['identity'],
  stored: SessionSummaryStoreEntry,
  messageCount: number
): void {
  // Why: nothing folded yet means there is no summary to remember, and recording an
  // empty ledger is what made the next visit claim "Up to date" over a blank body (#135).
  if (!hasProducedLedger(stored.ledger)) {
    return
  }
  // Chunk extracts covered by the new foldedThrough are already applied; drop them.
  const chunkCache: SessionSummaryStoreEntry['chunkCache'] = {}
  for (const [key, delta] of Object.entries(stored.chunkCache)) {
    const from = Number.parseInt(key.split('-')[0] ?? '', 10)
    if (Number.isFinite(from) && from >= stored.ledger.foldedThrough) {
      chunkCache[key] = delta
    }
  }
  deps.store.set(paneKey, {
    identity,
    ledger: stored.ledger,
    chunkCache,
    messageCount,
    seenThrough: stored.seenThrough,
    updatedAt: deps.now()
  })
}

function freshStoreEntry(
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
