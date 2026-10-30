// Fold protocol: bounded transcript slices → per-chunk extracts (in parallel)
// → one deterministic merge → one report rewrite.
//
// A failed or unparseable extract fails the whole fold so the caller keeps the last good
// ledger; completed chunk extracts are cacheable so a cancelled fold resumes instead of
// restarting. The report rewrite is the second phase (`session-summary-report.ts`) and its
// failure is survivable: facts without prose still beat losing the batch.
import type {
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
import { rewriteReports } from './session-summary-report'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

export type SessionSummarySourceEvent = {
  role: 'user' | 'assistant' | 'tool'
  text: string
  timestamp: string | null
}

/** One structured-output completion; the brain is agent-CLI or direct-model. */
export type SessionFoldBrain = {
  complete(input: { prompt: string; signal: AbortSignal }): Promise<string>
}

export type SessionSummaryChunkCache = {
  get(key: string): SessionSummaryLedgerDelta | undefined
  set(key: string, delta: SessionSummaryLedgerDelta): void
}

const CHUNK_MAX_CHARS = 24_000
const CHUNK_MAX_EVENTS = 40
const EVENT_TEXT_MAX_CHARS = 1_500

export type SessionSummaryChunkRange = { from: number; to: number }

/** Split [0, events.length) into bounded chunks. Deterministic: same inputs → same ranges, so cache keys are stable across resumes. */
export function buildSessionSummaryChunks(
  events: readonly SessionSummarySourceEvent[],
  chunkMaxChars = CHUNK_MAX_CHARS,
  chunkMaxEvents = CHUNK_MAX_EVENTS
): SessionSummaryChunkRange[] {
  const ranges: SessionSummaryChunkRange[] = []
  const eventCount = events.length
  let from = 0
  let chars = 0
  for (let index = 0; index < eventCount; index += 1) {
    chars += Math.min(events[index].text.length, EVENT_TEXT_MAX_CHARS)
    if (chars >= chunkMaxChars || index - from + 1 >= chunkMaxEvents) {
      ranges.push({ from, to: index + 1 })
      from = index + 1
      chars = 0
    }
  }
  if (from < eventCount) {
    ranges.push({ from, to: eventCount })
  }
  return ranges
}

export { extractSessionSummaryJson }

const CHUNK_EXTRACT_INSTRUCTIONS = `You are summarizing a slice of an agent coding session transcript.
Every fact is an object { "text": string, "sourceIndex": number } where "sourceIndex" is the message index shown in the transcript below for the message the fact came from.
Produce a JSON object with exactly these keys:
- "goal": fact or null — the objective the agent is working toward, if discernible
- "plan": fact[] — steps the agent laid out (at most 5, earliest first)
- "inProgress": fact or null — what the agent is doing at the END of this slice
- "done": fact[] — completed milestones (at most 5)
- "blockers": fact[] — errors, failed approaches, things awaiting input (at most 5)
- "decisions": fact[] — notable choices made (at most 5)
- "timeline": array of { "kind": one of "milestone"|"decision"|"error"|"needs-input"|"tool-burst"|"user-input", "text": one short sentence, "sourceIndex": number } — the notable events of this slice, chronological, at most 10.
Rules: respond with ONLY the JSON object. Use plain lowercase text. Keep each "text" to one short sentence. If the slice is ambiguous or low-signal, say so in few entries rather than inventing detail.`

function renderChunkTranscript(
  events: readonly SessionSummarySourceEvent[],
  range: SessionSummaryChunkRange,
  absoluteFrom: number
): string {
  const lines: string[] = []
  for (let index = range.from; index < range.to; index += 1) {
    const event = events[index]
    const text =
      event.text.length > EVENT_TEXT_MAX_CHARS
        ? `${event.text.slice(0, EVENT_TEXT_MAX_CHARS)}…`
        : event.text
    lines.push(`[#${absoluteFrom + index} ${event.role}] ${text}`)
  }
  return lines.join('\n')
}

export function buildSessionSummaryChunkPrompt(
  events: readonly SessionSummarySourceEvent[],
  range: SessionSummaryChunkRange,
  absoluteFrom: number
): string {
  return `${CHUNK_EXTRACT_INSTRUCTIONS}\n\nTranscript slice:\n${renderChunkTranscript(events, range, absoluteFrom)}`
}

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
}

/**
 * Fold events (events[0] is the transcript message at ledger.foldedThrough)
 * into the ledger. Atomic: on any chunk failure nothing is applied, so the
 * caller's stored ledger stays the last good one.
 */
export async function foldSessionSummaryEvents(args: {
  brain: SessionFoldBrain
  ledger: SessionSummaryLedger
  events: readonly SessionSummarySourceEvent[]
  signal: AbortSignal
  cache?: SessionSummaryChunkCache
  /**
   * When the transcript these events came from was read.
   *
   * Why the caller's clock and not `Date.now()` here: the freshness rule compares it with the
   * agent row's `updatedAt`, so stamping it after the model calls marks work that landed during
   * the fold as already folded — and the stale brief is then reused at any age.
   */
  readAt?: number
  onProgress?: (result: SessionSummaryFoldResult) => void
}): Promise<SessionSummaryFoldResult> {
  const { brain, ledger, events, signal, cache } = args
  const baseIndex = ledger.foldedThrough
  const ranges = buildSessionSummaryChunks(events)
  let completedChunks = 0
  const progress = (): void =>
    args.onProgress?.({ ledger, completedChunks, totalChunks: ranges.length })

  // Why the fold owns its controller: a failing chunk must stop its siblings instead of letting
  // them run to the generation timeout, and a pane close must reach every chunk's own process.
  const foldController = new AbortController()
  const abortFromCaller = (): void => foldController.abort(signal.reason)
  if (signal.aborted) {
    // A listener cannot observe an abort that already happened.
    foldController.abort(signal.reason)
  }
  signal.addEventListener('abort', abortFromCaller, { once: true })
  try {
    const foldSignal = foldController.signal
    const deltas = await mapWithConcurrency(
      ranges,
      SESSION_SUMMARY_FOLD_CHUNK_CONCURRENCY,
      async (range) => {
        foldSignal.throwIfAborted()
        const cacheKey = `${baseIndex + range.from}-${baseIndex + range.to}`
        const cached = cache?.get(cacheKey)
        if (cached) {
          completedChunks += 1
          progress()
          return cached
        }
        const raw = await brain.complete({
          prompt: buildSessionSummaryChunkPrompt(events, range, baseIndex),
          signal: foldSignal
        })
        foldSignal.throwIfAborted()
        // A fact the model did not index is placed at the slice's *last* message, not its first:
        // a slice usually opens with the reader's own message, and placing facts on that boundary
        // hid the whole slice from the "since your last message" window.
        const delta = normalizeSessionSummaryDelta(extractSessionSummaryJson(raw), {
          min: baseIndex + range.from,
          max: baseIndex + Math.max(range.from, range.to - 1),
          fallback: baseIndex + Math.max(range.from, range.to - 1)
        })
        if (!delta) {
          throw new Error('fold extract returned no usable JSON')
        }
        cache?.set(cacheKey, delta)
        completedChunks += 1
        progress()
        return delta
      }
    ).catch((error: unknown) => {
      foldController.abort(error)
      throw error
    })

    const merged = mergeSessionSummaryDeltas(deltas)
    const readerMessages = readerMessagesAfter(ledger, events, baseIndex)
    const folded = applySessionSummaryDelta(
      ledger,
      merged,
      baseIndex + events.length,
      args.readAt ?? Date.now(),
      readerMessages.lastUserMessageIndex,
      readerMessages.userMessageCount
    )
    // Why a second call and not a projection of the facts: a progress report is prose, and the
    // whole point of it is to be shorter and better organised than the facts are. Its input is the
    // previous reports plus this batch, and the prompt caps the timeline share of that, so it grows
    // with the batch rather than with the session.
    const reports = await rewriteReports({
      brain,
      signal: foldSignal,
      ledger,
      merged,
      through: folded.foldedThrough,
      windowRestarted: readerMessages.lastUserMessageIndex !== ledger.lastUserMessageIndex,
      userMessageCount: readerMessages.userMessageCount,
      lastUserMessageIndex: readerMessages.lastUserMessageIndex
    })
    // Why drop a carried-over "since" when the window moved: the previous one describes work the
    // reader has now spoken over, and a failed rewrite must not relabel it "since your last message".
    const reportSince = reports
      ? reports.since
      : readerMessages.lastUserMessageIndex === ledger.lastUserMessageIndex
        ? ledger.reportSince
        : null
    return {
      ledger: reports
        ? { ...folded, reportSince, reportFull: reports.full }
        : { ...folded, reportSince },
      completedChunks: ranges.length,
      totalChunks: ranges.length
    }
  } finally {
    signal.removeEventListener('abort', abortFromCaller)
  }
}
