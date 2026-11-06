// Giving up on a slice of a transcript.
//
// A single fold cannot tell "the model cannot summarize this slice" from "the brain is down", and
// every rule that guessed from one fold either stalled the session forever — one bad slice blocking
// every message after it — or threw work away during an outage. So the judgement needs evidence no
// fold has: how many *separate* folds a slice has failed on, persisted on the store.
//
// This module holds that judgement and the wording it produces, apart from the fold protocol so the
// rule can be tested on its own.
import type { SessionSummaryLedgerDelta } from '../../shared/session-summary-types'
import type { SessionSummaryChunkRange } from './session-summary-chunk-prompt'

/** What one chunk's model call produced, or why it produced nothing. */
export type ChunkOutcome =
  | { kind: 'delta'; delta: SessionSummaryLedgerDelta }
  | { kind: 'failed'; reason: unknown }

/** How many folds a slice may fail on before the fold gives up on it and names the hole. */
export const CHUNK_MAX_FOLD_FAILURES = 3

/**
 * How many folds each slice has failed on, persisted across folds.
 *
 * Why on the store: without evidence across folds, one unsummarizable slice stalls every message
 * after it for the life of the session, and the only alternative — abandoning on the first failure —
 * throws work away during a transient outage.
 */
export type SessionSummaryChunkFailureTracker = {
  /** Counts one failed fold for this slice and answers how many it has now had. */
  record(key: string): number
  /** The slice was summarized after all. */
  clear(key: string): void
}

/**
 * The counter key for one event.
 *
 * Why the event and not the range: the parts of a message too large for one prompt are one slice of
 * the transcript, so a fold that fails three of its parts has failed the event once.
 */
export function eventFailureKey(range: SessionSummaryChunkRange, baseIndex: number): string {
  return `${baseIndex + range.from}-${baseIndex + range.to}`
}

/**
 * Which slices this fold has established cannot be summarized, counting the fold against the rest.
 *
 * Why `brainAnswered` gates the whole thing: a fold where no model call completed is an outage, not
 * evidence about any slice, and holding it against them would skip a whole session after three bad
 * minutes. A cached extract is deliberately not evidence either — it says nothing about the brain now.
 */
export function recordFoldFailures(args: {
  settled: readonly PromiseSettledResult<ChunkOutcome>[]
  ranges: readonly SessionSummaryChunkRange[]
  baseIndex: number
  failures: SessionSummaryChunkFailureTracker | undefined
  brainAnswered: boolean
}): Set<number> {
  const abandoned = new Set<number>()
  if (!args.brainAnswered) {
    return abandoned
  }
  const failed = new Set<number>()
  const answered = new Set<number>()
  for (let index = 0; index < args.settled.length; index += 1) {
    const entry = args.settled[index]
    const isDelta = entry.status === 'fulfilled' && entry.value.kind === 'delta'
    const target = isDelta ? answered : failed
    target.add(args.ranges[index].from)
  }
  for (const eventIndex of answered) {
    const range = args.ranges.find((candidate) => candidate.from === eventIndex)
    if (range) {
      args.failures?.clear(eventFailureKey(range, args.baseIndex))
    }
  }
  for (const eventIndex of failed) {
    // A paged message whose other part succeeded was summarized; only a slice that failed whole
    // counts, and it counts once however many of its parts failed.
    if (answered.has(eventIndex)) {
      continue
    }
    const range = args.ranges.find((candidate) => candidate.from === eventIndex)
    if (!range) {
      continue
    }
    if (
      (args.failures?.record(eventFailureKey(range, args.baseIndex)) ?? 1) >=
      CHUNK_MAX_FOLD_FAILURES
    ) {
      abandoned.add(eventIndex)
    }
  }
  return abandoned
}

/** A slice the fold has given up on: named in the ledger so the pane accounts for it. */
export function describeAbandonedRange(range: SessionSummaryChunkRange, baseIndex: number): string {
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

/** The first reason a fold has to report, in slice order. */
export function firstRejectionReason(
  settled: readonly PromiseSettledResult<ChunkOutcome>[]
): Error | null {
  for (const entry of settled) {
    const reason =
      entry.status === 'rejected'
        ? entry.reason
        : entry.value.kind === 'delta'
          ? null
          : entry.value.reason
    if (reason !== null) {
      return reason instanceof Error ? reason : new Error(String(reason))
    }
  }
  return null
}
