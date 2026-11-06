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
  type SessionSummaryChunkRange,
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

const EMPTY_DELTA: SessionSummaryLedgerDelta = {}

/** A slice the fold has given up on: named in the ledger so the pane accounts for it. */
function describeAbandonedRange(range: SessionSummaryChunkRange, baseIndex: number): string {
  const from = baseIndex + range.from
  const to = baseIndex + Math.max(range.from, range.to - 1)
  if (range.partCount !== undefined) {
    // A message too large for one prompt was dropped whole: its parts are a paging device, not
    // separate messages, so naming a part would misdescribe what was lost.
    return `Message #${from} could not be summarized and was skipped.`
  }
  return from === to
    ? `Message #${from} could not be summarized and was skipped.`
    : `Messages #${from}-#${to} could not be summarized and were skipped.`
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
    // Why a breaker and not "the first chunk failed": whether a chunk failure means "this slice" or
    // "this brain" can only be told from another chunk settling, and a dead brain never provides
    // one. A full wave of chunks failing without a single success is that evidence, and it stops the
    // fold after two waves of calls instead of one per chunk of a long session.
    let consecutiveFailures = 0
    const settled = await mapSettledWithConcurrency(
      ranges,
      SESSION_SUMMARY_FOLD_CHUNK_CONCURRENCY,
      async (range) => {
        foldSignal.throwIfAborted()
        const cacheKey = chunkCacheKey(range, baseIndex)
        const cached = cache?.get(cacheKey)
        if (cached) {
          consecutiveFailures = 0
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
            consecutiveFailures = 0
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
        consecutiveFailures += 1
        if (consecutiveFailures >= SESSION_SUMMARY_FOLD_CHUNK_CONCURRENCY) {
          foldController.abort(lastError)
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError))
      }
    )

    // Why the decision is made here and not inside a chunk: a slice the model cannot summarize and a
    // brain that is not working look identical from one chunk. A chunk that did settle is the
    // evidence that separates them, and only the whole wave knows whether there is one.
    const firstRejected = settled.findIndex((entry) => entry.status === 'rejected')
    const abandoned: string[] = []
    let outcomes: readonly PromiseSettledResult<SessionSummaryLedgerDelta>[] = settled
    if (firstRejected !== -1) {
      const failedFrom = ranges[firstRejected].from
      const brainWorks = settled.some(
        (entry, index) => entry.status === 'fulfilled' && index !== firstRejected
      )
      // Why only the cursor event: the cursor can only stop on an event boundary, so abandoning an
      // event further in would leave a hole the cursor can never step over — a later failure
      // degrades the prefix instead.
      const atCursor = failedFrom === ranges[0].from
      if (atCursor && brainWorks) {
        outcomes = settled.map((entry, index) =>
          ranges[index].from === failedFrom && entry.status === 'rejected'
            ? { status: 'fulfilled' as const, value: EMPTY_DELTA }
            : entry
        )
        const skipped = settled.filter(
          (entry, index) => ranges[index].from === failedFrom && entry.status === 'rejected'
        ).length
        completedChunks += skipped
        abandoned.push(describeAbandonedRange(ranges[firstRejected], baseIndex))
      } else if (atCursor) {
        // Nothing settled anywhere: the brain is not working, not the slice. Stopping the siblings
        // keeps a misconfigured agent to one call instead of one per chunk.
        const failed = settled[firstRejected]
        const reason = failed.status === 'rejected' ? failed.reason : new Error('fold failed')
        foldController.abort(reason)
        throw reason instanceof Error ? reason : new Error(String(reason))
      }
    }

    let lastApplied = appliedPrefix(outcomes)
    // S2: a part range must not leave half an event applied. The cursor stops at an event index, so
    // backing off to before the split event is what keeps its earlier parts from landing twice.
    const stopRange = lastApplied !== -1 ? ranges[lastApplied + 1] : undefined
    if (stopRange?.partFrom !== undefined && stopRange.partFrom > 0) {
      while (lastApplied !== -1 && ranges[lastApplied].from === stopRange.from) {
        lastApplied -= 1
      }
    }
    if (lastApplied === -1) {
      // Only reachable after backing off a partially applied event, so the reason to report is the
      // chunk that actually failed rather than a generic "nothing landed".
      const failed = settled[firstRejected]
      const reason =
        failed?.status === 'rejected' ? failed.reason : new Error('fold produced no chunks')
      foldController.abort(reason)
      throw reason instanceof Error ? reason : new Error(String(reason))
    }

    const deltas = outcomes.slice(0, lastApplied + 1).map((entry) => {
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
