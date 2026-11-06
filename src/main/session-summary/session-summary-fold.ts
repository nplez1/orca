// Fold protocol: bounded transcript slices → per-chunk extracts (in parallel) → one deterministic
// merge → a report chain over the unfolded range.
//
// Three things are deliberately kept apart. *Paging* decides how many model calls a fold takes
// (`CHUNK_MAX_CHARS` / `CHUNK_MAX_EVENTS`) and never what the model may see. *Truncation* — dropping
// content by position once a character budget is hit — is gone. What the model sees is the digest
// (`session-summary-event-digest.ts`), which represents every event at the detail its role deserves.
//
// A failing chunk no longer loses the fold: the chunks before it are applied and the rest stay in
// the cache, so the next fold fills the gap. Two things are separate from that. A full wave of
// chunks failing without a single success is a brain that is not working, and a shared breaker stops
// the fold rather than paying for one call per chunk. And a slice that keeps failing across folds is
// given up on and named, because otherwise one unsummarizable slice stalls every message after it
// for the life of the session — one fold cannot tell that slice from an outage, so the count lives
// on the store.
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
import {
  describeAbandonedRange,
  firstRejectionReason,
  recordFoldFailures,
  type ChunkOutcome,
  type SessionSummaryChunkFailureTracker
} from './session-summary-fold-failure'

export type { SessionSummaryChunkFailureTracker } from './session-summary-fold-failure'

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

const EMPTY_DELTA: SessionSummaryLedgerDelta = {}

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
function appliedPrefix(settled: readonly PromiseSettledResult<ChunkOutcome>[]): number {
  let last = -1
  for (let index = 0; index < settled.length; index += 1) {
    const entry = settled[index]
    if (entry.status !== 'fulfilled' || entry.value.kind !== 'delta') {
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
  /** How many folds each slice has already failed on. */
  failures?: SessionSummaryChunkFailureTracker
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
  const { brain, ledger, events, signal, cache, failures } = args
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
    // Why a breaker: a brain that is not working never provides the evidence that separates it from
    // an unsummarizable slice, so the fold would otherwise pay for one call per chunk. A full wave
    // of chunks failing without a single success is that evidence, and it bounds the cost to one
    // wave. It is not the abandonment rule — that needs evidence a single fold cannot have.
    let consecutiveFailures = 0
    // Which slices a model call answered for in *this* fold. Why it matters separately from a cached
    // extract: only a real completion is evidence the brain works, and only a fold that demonstrably
    // worked may hold a slice's failure against it — otherwise an outage would be remembered as
    // three folds of unsummarizable slices and the whole session would be skipped.
    const freshRanges = new Set<number>()
    const settled = await mapSettledWithConcurrency(
      ranges,
      SESSION_SUMMARY_FOLD_CHUNK_CONCURRENCY,
      async (range, rangeIndex): Promise<ChunkOutcome> => {
        foldSignal.throwIfAborted()
        const cacheKey = chunkCacheKey(range, baseIndex)
        const cached = cache?.get(cacheKey)
        if (cached) {
          consecutiveFailures = 0
          completedChunks += 1
          reportProgress()
          return { kind: 'delta', delta: cached }
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
            freshRanges.add(rangeIndex)
            consecutiveFailures = 0
            completedChunks += 1
            reportProgress()
            return { kind: 'delta', delta }
          } catch (error) {
            if (foldSignal.aborted) {
              throw error
            }
            lastError = error
          }
        }
        consecutiveFailures += 1
        if (consecutiveFailures >= SESSION_SUMMARY_FOLD_CHUNK_CONCURRENCY) {
          foldController.abort(lastError)
        }
        return { kind: 'failed', reason: lastError }
      }
    )

    const abandonedEvents = recordFoldFailures({
      settled,
      ranges,
      baseIndex,
      failures,
      brainAnswered: freshRanges.size > 0,
      aborted: foldSignal.aborted
    })

    // Why the whole event: a message too large for one prompt is paged, not split into messages, so
    // half of it landing while the pane says the message was skipped would be a false account.
    const outcomes: PromiseSettledResult<ChunkOutcome>[] = settled.map((entry, index) => {
      if (!abandonedEvents.has(ranges[index].from)) {
        return entry
      }
      return { status: 'fulfilled' as const, value: { kind: 'delta', delta: EMPTY_DELTA } }
    })
    completedChunks += abandonedEvents.size

    let lastApplied = appliedPrefix(outcomes)
    // A part range must not leave half an event applied. The cursor stops at an event index, so
    // backing off to before the split event is what keeps its earlier parts from landing twice.
    const stopRange = lastApplied !== -1 ? ranges[lastApplied + 1] : undefined
    if (stopRange?.partFrom !== undefined && stopRange.partFrom > 0) {
      while (lastApplied !== -1 && ranges[lastApplied].from === stopRange.from) {
        lastApplied -= 1
      }
    }
    if (lastApplied === -1) {
      // Nothing before the failure settled. Why that is not always a failure: a slice that is merely
      // failing — not yet at its third fold — must still record the gap, or the brief reads as
      // current and the retry never happens on an idle session. Only a fold where *nothing* settled
      // is a brain that is not working, and that has to stay visible.
      if (freshRanges.size === 0) {
        const reason = firstRejectionReason(outcomes) ?? new Error('fold produced no chunks')
        foldController.abort(reason)
        throw reason
      }
    }

    const deltas = outcomes.slice(0, lastApplied + 1).map((entry) => {
      // The prefix is all deltas by construction: `appliedPrefix` stops at anything else.
      if (entry.status !== 'fulfilled' || entry.value.kind !== 'delta') {
        throw new Error('fold applied a chunk that did not settle')
      }
      return entry.value.delta
    })
    const gap: SessionSummaryFoldGap | null =
      lastApplied === ranges.length - 1
        ? null
        : { completedChunks: lastApplied + 1, totalChunks: ranges.length }
    // Why the next chunk's start and not its own end: a chunk that failed was not applied, so the
    // cursor has to stop where it begins or the next fold would skip it.
    const foldedThrough =
      gap === null ? baseIndex + events.length : baseIndex + ranges[lastApplied + 1].from

    // Why only below the cursor: an event whose slice was given up on but which sits past the point
    // the cursor stops at was not skipped, and saying so would leave a false entry in the ledger that
    // no later fold withdraws.
    const abandoned: string[] = []
    for (const eventIndex of abandonedEvents) {
      if (baseIndex + eventIndex >= foldedThrough) {
        continue
      }
      const range = ranges.find((candidate) => candidate.from === eventIndex)
      if (range) {
        abandoned.push(describeAbandonedRange(range, baseIndex))
      }
    }

    const merged = mergeSessionSummaryDeltas(deltas)
    // Why sliced: a degraded fold stops at the first failed chunk, so counting the reader's messages
    // across the whole read would count the ones the next fold is about to count again.
    const readerMessages = readerMessagesAfter(
      ledger,
      events.slice(0, foldedThrough - baseIndex),
      baseIndex
    )
    const folded = applySessionSummaryDelta(
      ledger,
      merged,
      foldedThrough,
      args.readAt ?? Date.now(),
      readerMessages.lastUserMessageIndex,
      readerMessages.userMessageCount,
      { foldGap: gap, gaps: [...gaps.map((entry) => entry.text), ...abandoned] }
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
