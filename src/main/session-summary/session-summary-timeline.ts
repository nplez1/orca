// The timeline as a projection: one answer per `(kind, sourceIndex)`, derived rather than written.
//
// It used to be model output — the extract was asked for up to ten notable events per chunk. That
// cost output tokens, inflated the report prompt, and was not reproducible: re-folding a range
// after a cache miss could append and reword the same events. Every kind already had a
// deterministic source, so the projection reads them instead.
//
// Facts (`done`, `decisions`, `blockers`) are the judgment half and the fold already stores them
// with provenance. Markers are the programmatic half — the reader's own messages, tool bursts and
// the failures inside them — planned from the events the fold just read.
import type {
  SessionSummaryFact,
  SessionSummaryLedger,
  SessionSummaryTimelineDeltaEntry,
  SessionSummaryTimelineEntry,
  SessionSummaryTimelineKind
} from '../../shared/session-summary-types'
import type { SessionSummarySourceEvent } from './session-summary-event-digest'
import {
  describeSessionSummaryToolBurst,
  planSessionSummaryToolRuns
} from './session-summary-render-plan'

/** How much of the reader's own message a `user-input` entry quotes. */
const USER_INPUT_MAX_CHARS = 200
/**
 * Calls a run needs before it is a phase of work rather than an errand.
 *
 * Why five and not two: two or three reads happen between almost every assistant message, and a
 * timeline of those is a play-by-play — which is the thing this change removes. A burst line in
 * the *prompt* has no such threshold; there it is about prompt size, not about what is notable.
 */
const TOOL_BURST_MIN_CALLS = 5

/** The facts the projection reads, in the shape both a ledger and a delta provide. */
export type SessionSummaryTimelineFacts = Pick<
  SessionSummaryLedger,
  'done' | 'decisions' | 'blockers'
>

/**
 * The deterministic half of the timeline, for one fold's applied prefix.
 *
 * `baseIndex` is the transcript index of `events[0]` — the ledger's `foldedThrough` before this
 * fold — because a marker's anchor has to be a transcript index like every fact's.
 */
export function planSessionSummaryTimelineMarkers(
  events: readonly SessionSummarySourceEvent[],
  baseIndex: number
): SessionSummaryTimelineDeltaEntry[] {
  const markers: SessionSummaryTimelineDeltaEntry[] = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.role !== 'user') {
      continue
    }
    markers.push({
      kind: 'user-input',
      text: excerpt(event.text),
      sourceIndex: baseIndex + index
    })
  }
  for (const run of planSessionSummaryToolRuns(events)) {
    if (run.calls.length >= TOOL_BURST_MIN_CALLS) {
      markers.push({
        kind: 'tool-burst',
        text: describeSessionSummaryToolBurst(run.calls),
        sourceIndex: baseIndex + run.from
      })
    }
    for (const call of run.calls) {
      // Why only a quoted failure line: a bare nonzero exit is not evidence of a problem. `rg`
      // exits 1 when nothing matched, and an `error` row for that is noise the reader cannot use.
      if (!call.failed || !call.failureLine) {
        continue
      }
      markers.push({
        kind: 'error',
        text: `${call.label} · ${call.failureLine}`,
        sourceIndex: baseIndex + call.from
      })
    }
  }
  return markers
}

function excerpt(text: string): string {
  const firstLine = text.split('\n', 1)[0].trim()
  return firstLine.length > USER_INPUT_MAX_CHARS
    ? `${firstLine.slice(0, USER_INPUT_MAX_CHARS - 1)}…`
    : firstLine
}

function markerKey(marker: SessionSummaryTimelineDeltaEntry): string {
  return `${marker.kind}-${marker.sourceIndex}`
}

/**
 * Markers in fold order, one per `(kind, sourceIndex)`.
 *
 * Why dedupe at all: a re-fold of a range after a cache miss replans the same markers, and a
 * projection with two answers for one event is exactly the non-reproducibility this replaces.
 */
export function mergeSessionSummaryMarkers(
  previous: readonly SessionSummaryTimelineDeltaEntry[],
  next: readonly SessionSummaryTimelineDeltaEntry[]
): SessionSummaryTimelineDeltaEntry[] {
  if (next.length === 0) {
    return [...previous]
  }
  const out = [...previous]
  const seen = new Set(previous.map(markerKey))
  for (const marker of next) {
    const key = markerKey(marker)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(marker)
  }
  return out
}

/** Tie-break for two entries anchored at the same message: the prompt's own order of importance. */
const KIND_ORDER: Record<SessionSummaryTimelineKind, number> = {
  'user-input': 0,
  'tool-burst': 1,
  error: 2,
  'needs-input': 3,
  decision: 4,
  milestone: 5
}

/**
 * The ledger's timeline, from its facts and its markers.
 *
 * Ordered by `sourceIndex`, so the projection is append-only in practice: a fold's new facts and
 * markers are anchored inside the slice it just read, which is entirely after every message the
 * ledger has already folded. That is what keeps the count-based "new since last view" cursor
 * meaningful across folds.
 *
 * A fact with no index is skipped rather than anchored at zero: the timeline's position *is* its
 * provenance, and the pane's "since your last message" window cannot place an entry without one.
 */
export function projectSessionSummaryTimeline(
  facts: SessionSummaryTimelineFacts,
  markers: readonly SessionSummaryTimelineDeltaEntry[]
): SessionSummaryTimelineEntry[] {
  const candidates: SessionSummaryTimelineDeltaEntry[] = []
  const pushFacts = (
    list: readonly SessionSummaryFact[],
    kind: SessionSummaryTimelineKind
  ): void => {
    for (const fact of list) {
      if (fact.sourceIndex !== null) {
        candidates.push({ kind, text: fact.text, sourceIndex: fact.sourceIndex })
      }
    }
  }
  pushFacts(facts.done, 'milestone')
  pushFacts(facts.decisions, 'decision')
  pushFacts(facts.blockers, 'error')
  // Why a blocker hides a failure marker at the same index: a failed command is usually also what
  // the extract wrote a blocker about, and two error rows for one failure read as two problems.
  const blockerIndexes = new Set(facts.blockers.map((fact) => fact.sourceIndex))
  for (const marker of markers) {
    if (marker.kind === 'error' && blockerIndexes.has(marker.sourceIndex)) {
      continue
    }
    candidates.push(marker)
  }
  const ordered = candidates.map((entry, order) => ({ entry, order }))
  ordered.sort(
    (left, right) =>
      left.entry.sourceIndex - right.entry.sourceIndex ||
      KIND_ORDER[left.entry.kind] - KIND_ORDER[right.entry.kind] ||
      left.order - right.order
  )
  // Why an ordinal and not just `(kind, sourceIndex)`: a chunk whose extract omits `sourceIndex`
  // anchors every one of its facts at the slice's last message, so two milestones can share an
  // index — and duplicate ids are duplicate React keys and a wrong seen cursor.
  const repeats = new Map<string, number>()
  return ordered.map(({ entry }) => {
    const base = `${entry.kind}-${entry.sourceIndex}`
    const count = (repeats.get(base) ?? 0) + 1
    repeats.set(base, count)
    return {
      id: count === 1 ? base : `${base}-${count}`,
      kind: entry.kind,
      text: entry.text,
      sourceIndex: entry.sourceIndex
    }
  })
}
