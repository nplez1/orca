// Fold protocol: bounded transcript slices → per-chunk extracts (in parallel) → one deterministic
// merge → a report chain over the unfolded range.
//
// Three things are deliberately kept apart. *Paging* decides how many model calls a fold takes
// (`CHUNK_MAX_CHARS` / `CHUNK_MAX_EVENTS`) and never what the model may see. *Truncation* — dropping
// content by position once a character budget is hit — is gone. What the model sees is the digest
// (`session-summary-event-digest.ts`), which represents every event at the detail its role deserves.
//
// A failing chunk no longer loses the fold: the chunks before it are applied and the rest stay in
// the cache, so the next fold fills the gap. A failure in the *first* chunk is the one case with
// nothing to degrade to, and it stops its siblings rather than spawning a call per chunk against a
// brain that is not working.
import type {
  SessionSummaryFoldGap,
  SessionSummaryLedger,
  SessionSummaryLedgerDelta
} from '../../shared/session-summary-types'
import {
  applySessionSummaryDelta,
  mergeSessionSummaryDeltas,
  normalizeSessionSummaryDelta
} from './session-summary-ledger'
import { SESSION_SUMMARY_FOLD_CHUNK_CONCURRENCY } from './session-summary-fold-slots'
import { extractSessionSummaryJson } from './session-summary-json'

export { extractSessionSummaryJson }
import { rewriteSessionSummaryReports } from './session-summary-report'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import type { SessionSummarySourceEvent } from './session-summary-event-digest'

import {
  buildSessionSummaryChunks,
  buildSessionSummaryChunkPrompt,
  chunkCacheKey,
  rangeLastEventIndex,
  type SessionSummaryGap
} from './session-summary-chunk-prompt'

export type { SessionSummarySourceEvent }
export {
  buildSessionSummaryChunks,
  buildSessionSummaryChunkPrompt,
  type SessionSummaryChunkRange,
  type SessionSummaryGap
} from './session-summary-chunk-prompt'

/** One structured-output completion; the brain is agent-CLI or direct-model. */
export type SessionFoldBrain = {
  complete(input: { prompt: string; signal: AbortSignal }): Promise<string>
}

export type SessionSummaryChunkCache = {
  get(key: string): SessionSummaryLedgerDelta | undefined
  set(key: string, delta: SessionSummaryLedgerDelta): void
}

/** Attempts per chunk. A JSON miss is usually transient; a third doubles a genuinely broken call. */
const CHUNK_ATTEMPTS = 2

/**
 * Where the reader's own last message sits, after folding this batch.
 *
 * This is the "since I last interacted" line, and it is derived here rather than stored by the
 * UI: the transcript is the one artifact every host folds, and it survives a restart, a
 * reconnect and a paired host, which a "the pane was closed at 14:02" cursor does not.
 */
function readerMessagesAfter(
  ledger: SessionSummaryLedger,
  events: readonly SessionSummarySourceEvent[],
  baseIndex: number
): { lastUserMessageIndex: number | null; userMessageCount: number } {
  let lastUserMessageIndex = ledger.lastUserMessageIndex
  let userMessageCount = ledger.userMessageCount
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].role === 'user') {
      lastUserMessageIndex = baseIndex + index
      userMessageCount += 1
    }
  }
  return { lastUserMessageIndex, userMessageCount }
}

export type SessionSummaryFoldResult = {
  ledger: SessionSummaryLedger
  completedChunks: number
  totalChunks: number
  /** Chunks that could not be summarized; the next fold resumes at the first of them. */
  gap: SessionSummaryFoldGap | null
}

/** How many chunks the extract phase finished, and where the applied prefix ends. */
function appliedPrefix(
  settled: readonly PromiseSettledResult<SessionSummaryLedgerDelta>[]
): number {
  let last = -1
  for (let index = 0; index < settled.length; index += 1) {
    if (settled[index].status !== 'fulfilled') {
      break
    }
    last = index
  }
  return last
}

/**
 * Fold events (events[0] is the transcript message at ledger.foldedThrough) into the ledger.
 *
 * Degrades instead of aborting: chunks before the first failure are applied, so a forty-chunk fold
 * with one flaky call still yields a summary of thirty-nine. The cursor stops at the first failed
 * chunk — applying a later one would either renumber the events or, on the next fold, append its
 * timeline entries a second time.
 */
export async function foldSessionSummaryEvents(args: {
  brain: SessionFoldBrain
  ledger: SessionSummaryLedger
  events: readonly SessionSummarySourceEvent[]
  signal: AbortSignal
  cache?: SessionSummaryChunkCache
  /** Parts of the transcript the reader skipped; named in the slice that covers them. */
  gaps?: readonly SessionSummaryGap[]
  /**
   * When the transcript these events came from was read.
   *
   * Why the caller's clock and not `Date.now()` here: the freshness rule compares it with the
   * agent row's `updatedAt`, so stamping it after the model calls marks work that landed during
   * the fold as already folded — and the stale brief is then reused at any age.
   */
  readAt?: number
  onProgress?: (result: SessionSummaryFoldResult) => void
  /** Reports a completed chunk to the store, so an interrupted fold resumes instead of restarting. */
  onChunkSettled?: () => void
}): Promise<SessionSummaryFoldResult> {
  const { brain, ledger, events, signal, cache } = args
  const baseIndex = ledger.foldedThrough
  const ranges = buildSessionSummaryChunks(events)
  const gaps = args.gaps ?? []
  let completedChunks = 0
  const reportProgress = (): void => {
    args.onChunkSettled?.()
    args.onProgress?.({ ledger, completedChunks, totalChunks: ranges.length, gap: null })
  }

  // Why the fold owns its controller: a pane close must reach every chunk's own process, and a
  // first-chunk failure has to stop siblings rather than run them against a broken brain.
  const foldController = new AbortController()
  const abortFromCaller = (): void => foldController.abort(signal.reason)
  if (signal.aborted) {
    // A listener cannot observe an abort that already happened.
    foldController.abort(signal.reason)
  }
  signal.addEventListener('abort', abortFromCaller, { once: true })
  try {
    const foldSignal = foldController.signal
    const settled = await mapSettledWithConcurrency(
      ranges,
      SESSION_SUMMARY_FOLD_CHUNK_CONCURRENCY,
      async (range, rangeIndex) => {
        foldSignal.throwIfAborted()
        const cacheKey = chunkCacheKey(range, baseIndex)
        const cached = cache?.get(cacheKey)
        if (cached) {
          completedChunks += 1
          reportProgress()
          return cached
        }
        let lastError: unknown = null
        for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt += 1) {
          try {
            const raw = await brain.complete({
              prompt: buildSessionSummaryChunkPrompt(events, range, baseIndex, gaps),
              signal: foldSignal
            })
            foldSignal.throwIfAborted()
            // A fact the model did not index is placed at the slice's *last* message, not its first:
            // a slice usually opens with the reader's own message, and placing facts on that boundary
            // hid the whole slice from the "since your last message" window.
            const last = baseIndex + rangeLastEventIndex(range)
            const delta = normalizeSessionSummaryDelta(extractSessionSummaryJson(raw), {
              min: baseIndex + range.from,
              max: last,
              fallback: last
            })
            if (!delta) {
              throw new Error('fold extract returned no usable JSON')
            }
            cache?.set(cacheKey, delta)
            completedChunks += 1
            reportProgress()
            return delta
          } catch (error) {
            if (foldSignal.aborted) {
              throw error
            }
            lastError = error
          }
        }
        // Why stop the rest here: with the first chunk unusable there is no prefix to keep, so
        // every later chunk is a model call whose answer cannot be applied. This is the one failure
        // that aborts its siblings; a later one degrades instead.
        if (rangeIndex === 0) {
          foldController.abort(lastError)
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError))
      }
    )

    const lastApplied = appliedPrefix(settled)
    if (lastApplied < 0) {
      // Nothing landed: there is no prefix to keep and nothing to resume from, so this is a
      // failure. Stopping the siblings is what keeps a misconfigured brain to two calls.
      const first = settled[0]
      foldController.abort(
        first?.status === 'rejected' ? first.reason : new Error('fold produced no chunks')
      )
      throw first?.status === 'rejected' ? first.reason : new Error('fold produced no chunks')
    }

    const deltas = settled.slice(0, lastApplied + 1).map((entry) => {
      // The prefix is fulfilled by construction: `appliedPrefix` stops at the first rejection.
      if (entry.status !== 'fulfilled') {
        throw new Error('fold applied a chunk that did not settle')
      }
      return entry.value
    })
    const gap: SessionSummaryFoldGap | null =
      lastApplied === ranges.length - 1
        ? null
        : { completedChunks: lastApplied + 1, totalChunks: ranges.length }
    // Why the next chunk's start and not its own end: a chunk that failed was not applied, so the
    // cursor has to stop where it begins or the next fold would skip it.
    const foldedThrough =
      gap === null ? baseIndex + events.length : baseIndex + ranges[lastApplied + 1].from

    const merged = mergeSessionSummaryDeltas(deltas)
    const readerMessages = readerMessagesAfter(ledger, events, baseIndex)
    const folded = applySessionSummaryDelta(
      ledger,
      merged,
      foldedThrough,
      args.readAt ?? Date.now(),
      readerMessages.lastUserMessageIndex,
      readerMessages.userMessageCount,
      { foldGap: gap, gaps: gaps.map((entry) => entry.text) }
    )
    const reports = await rewriteSessionSummaryReports({
      brain,
      signal: foldSignal,
      ledger,
      folded,
      windowRestarted: readerMessages.lastUserMessageIndex !== ledger.lastUserMessageIndex,
      userMessageCount: readerMessages.userMessageCount,
      lastUserMessageIndex: readerMessages.lastUserMessageIndex
    })
    // Why drop a carried-over "since" when the window moved: the previous one describes work the
    // reader has now spoken over, and a failed rewrite must not relabel it "since your last message".
    const reportSince = reports.since
      ? reports.since
      : readerMessages.lastUserMessageIndex === ledger.lastUserMessageIndex
        ? ledger.reportSince
        : null
    return {
      ledger: {
        ...folded,
        reportSince,
        reportFull: reports.full ?? folded.reportFull
      },
      completedChunks: gap === null ? ranges.length : gap.completedChunks,
      totalChunks: ranges.length,
      gap
    }
  } finally {
    signal.removeEventListener('abort', abortFromCaller)
  }
}
