// Pure ledger operations: model output normalization and delta application.
// Facts update in place; the timeline is append-only (entries are counted by
// index for "since you last looked", so rewrites would move the cursor).
import type {
  SessionSummaryFact,
  SessionSummaryLedger,
  SessionSummaryLedgerDelta,
  SessionSummaryTimelineDeltaEntry,
  SessionSummaryTimelineKind
} from '../../shared/session-summary-types'
import {
  SESSION_SUMMARY_LIST_MAX_ITEMS,
  SESSION_SUMMARY_TEXT_MAX_LENGTH,
  SESSION_SUMMARY_TIMELINE_KINDS
} from '../../shared/session-summary-types'

export function emptySessionSummaryLedger(): SessionSummaryLedger {
  return {
    goal: null,
    plan: [],
    inProgress: null,
    done: [],
    blockers: [],
    decisions: [],
    timeline: [],
    reportSince: null,
    reportFull: null,
    lastUserMessageIndex: null,
    userMessageCount: 0,
    foldedThrough: 0,
    foldedAt: null
  }
}

/**
 * Whether a fold ever produced this ledger.
 *
 * An empty ledger is not a summary of nothing — it is the absence of one. Recording it
 * makes the next visit read `ready` and say "Up to date" over a blank body, so every
 * write path checks this first.
 */
export function hasProducedLedger(ledger: SessionSummaryLedger): boolean {
  return ledger.foldedAt !== null || ledger.foldedThrough > 0 || ledger.timeline.length > 0
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  return trimmed.length > SESSION_SUMMARY_TEXT_MAX_LENGTH
    ? `${trimmed.slice(0, SESSION_SUMMARY_TEXT_MAX_LENGTH - 1)}…`
    : trimmed
}

/**
 * The transcript indexes an extract's facts may legitimately name.
 *
 * A model that answers with a slice-relative index (0 for the first message of its slice) would
 * otherwise place every fact in that slice *before* the reader's last message and hide the whole
 * slice from the window, so an out-of-range index falls back to the slice's own placement.
 */
export type SessionSummaryFactIndexRange = {
  min: number
  max: number
  /** Where an unindexed or out-of-range fact goes: the slice's last message. */
  fallback: number
}

/**
 * One fact, with the message index it came from.
 *
 * A bare string is accepted as well: an extract that ignored the `sourceIndex` request still says
 * something true, and the slice's placement puts it in the window rather than outside it.
 */
function normalizeFact(
  value: unknown,
  indexes: SessionSummaryFactIndexRange | null
): SessionSummaryFact | null {
  if (typeof value === 'string') {
    const text = normalizeText(value)
    return text === null ? null : { text, sourceIndex: indexes?.fallback ?? null }
  }
  if (!isRecord(value)) {
    return null
  }
  const text = normalizeText(value.text)
  if (text === null) {
    return null
  }
  const raw = value.sourceIndex
  const claimed =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : null
  // No slice range (a caller applying a delta outside the fold) can only trust what it is given.
  const inRange =
    claimed !== null && (indexes === null || (claimed >= indexes.min && claimed <= indexes.max))
  return { text, sourceIndex: inRange ? claimed : (indexes?.fallback ?? null) }
}

function normalizeFactList(
  value: unknown,
  indexes: SessionSummaryFactIndexRange | null
): SessionSummaryFact[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: SessionSummaryFact[] = []
  for (const item of value) {
    const fact = normalizeFact(item, indexes)
    if (fact !== null && !out.some((existing) => existing.text === fact.text)) {
      out.push(fact)
    }
    if (out.length >= SESSION_SUMMARY_LIST_MAX_ITEMS) {
      break
    }
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTimelineKind(value: unknown): value is SessionSummaryTimelineKind {
  return typeof value === 'string' && SESSION_SUMMARY_TIMELINE_KINDS.some((kind) => kind === value)
}

function normalizeTimeline(value: unknown): SessionSummaryTimelineDeltaEntry[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: SessionSummaryTimelineDeltaEntry[] = []
  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }
    const obj = item
    const text = normalizeText(obj.text)
    const sourceIndex = obj.sourceIndex
    if (text === null || !isTimelineKind(obj.kind) || typeof sourceIndex !== 'number') {
      continue
    }
    out.push({
      kind: obj.kind,
      text,
      sourceIndex: Number.isFinite(sourceIndex) && sourceIndex >= 0 ? Math.floor(sourceIndex) : 0
    })
  }
  return out
}

/**
 * Normalize an untrusted (model-produced) delta. Null when nothing usable is present.
 *
 * `indexes` is the transcript range this extract read; it places any fact the model did not
 * index and rejects an index outside the slice.
 */
export function normalizeSessionSummaryDelta(
  value: unknown,
  indexes: SessionSummaryFactIndexRange | null = null
): SessionSummaryLedgerDelta | null {
  if (!isRecord(value)) {
    return null
  }
  const obj = value
  const delta: SessionSummaryLedgerDelta = {}
  if ('goal' in obj) {
    delta.goal = obj.goal === null ? null : normalizeFact(obj.goal, indexes)
  }
  if ('inProgress' in obj) {
    delta.inProgress = obj.inProgress === null ? null : normalizeFact(obj.inProgress, indexes)
  }
  if ('plan' in obj) {
    delta.plan = normalizeFactList(obj.plan, indexes)
  }
  if ('done' in obj) {
    delta.done = normalizeFactList(obj.done, indexes)
  }
  if ('blockers' in obj) {
    delta.blockers = normalizeFactList(obj.blockers, indexes)
  }
  if ('decisions' in obj) {
    delta.decisions = normalizeFactList(obj.decisions, indexes)
  }
  if ('timeline' in obj) {
    delta.timeline = normalizeTimeline(obj.timeline)
  }
  return Object.keys(delta).length > 0 ? delta : null
}

/**
 * Ordered union by text, keeping the *earliest* message index each fact was seen at.
 *
 * Why the earliest: a fact restated in a later chunk did not become news when it was repeated,
 * and the "since your last message" window is computed from these indexes.
 */
function mergeFactLists(...lists: SessionSummaryFact[][]): SessionSummaryFact[] {
  const out: SessionSummaryFact[] = []
  for (const list of lists) {
    for (const fact of list) {
      const existing = out.find((item) => item.text === fact.text)
      if (!existing) {
        out.push(fact)
        continue
      }
      if (fact.sourceIndex === null) {
        continue
      }
      if (existing.sourceIndex === null || fact.sourceIndex < existing.sourceIndex) {
        existing.sourceIndex = fact.sourceIndex
      }
    }
  }
  return out.slice(0, SESSION_SUMMARY_LIST_MAX_ITEMS)
}

/**
 * Fold chunk deltas into one delta, in chunk order. Scalars: the last chunk
 * that expressed an opinion wins (it saw the most recent context). Lists:
 * ordered union. Timeline: concatenation in chunk order.
 */
export function mergeSessionSummaryDeltas(
  deltas: readonly SessionSummaryLedgerDelta[]
): SessionSummaryLedgerDelta {
  const merged: SessionSummaryLedgerDelta = { timeline: [] }
  for (const delta of deltas) {
    // Why only a real opinion: chunks are merged in order, and a later chunk that says nothing
    // about the goal used to erase the one an earlier chunk had just found.
    if (delta.goal) {
      merged.goal = delta.goal
    }
    if ('inProgress' in delta) {
      merged.inProgress = delta.inProgress
    }
    if (delta.plan) {
      merged.plan = mergeFactLists(merged.plan ?? [], delta.plan)
    }
    if (delta.done) {
      merged.done = mergeFactLists(merged.done ?? [], delta.done)
    }
    if (delta.blockers) {
      merged.blockers = mergeFactLists(merged.blockers ?? [], delta.blockers)
    }
    if (delta.decisions) {
      merged.decisions = mergeFactLists(merged.decisions ?? [], delta.decisions)
    }
    if (delta.timeline) {
      merged.timeline = [...(merged.timeline ?? []), ...delta.timeline]
    }
  }
  return merged
}

/**
 * Apply a (merged) delta to a ledger. Pure: returns a new ledger whose
 * `foldedThrough` has advanced to `foldedThrough`. Absent delta fields leave their ledger field
 * untouched; an explicit null clears `inProgress`, and leaves `goal` alone — a goal is replaced,
 * never unset, so the title survives a chunk that has nothing to say about it.
 */
export function applySessionSummaryDelta(
  ledger: SessionSummaryLedger,
  delta: SessionSummaryLedgerDelta,
  foldedThrough: number,
  foldedAt: number,
  lastUserMessageIndex: number | null = ledger.lastUserMessageIndex,
  userMessageCount: number = ledger.userMessageCount
): SessionSummaryLedger {
  return {
    // Why the last non-null wins: a later chunk that says nothing about the goal must not erase
    // the title. A goal is replaced, never unset, so an explicit null is "no opinion", not "none".
    goal: delta.goal ?? ledger.goal,
    plan: delta.plan ? mergeFactLists(ledger.plan, delta.plan) : ledger.plan,
    inProgress: 'inProgress' in delta ? (delta.inProgress ?? null) : ledger.inProgress,
    done: delta.done ? mergeFactLists(ledger.done, delta.done) : ledger.done,
    blockers: delta.blockers ? mergeFactLists(ledger.blockers, delta.blockers) : ledger.blockers,
    decisions: delta.decisions
      ? mergeFactLists(ledger.decisions, delta.decisions)
      : ledger.decisions,
    timeline: [
      ...ledger.timeline,
      ...(delta.timeline ?? []).map((entry, index) => ({
        ...entry,
        id: `${entry.sourceIndex}-${entry.kind}-${ledger.timeline.length + index}`
      }))
    ],
    // Carried, not derived: reports are written by the fold's report step, and a delta apply
    // (which also runs for facts alone) must not silently drop them.
    reportSince: ledger.reportSince,
    reportFull: ledger.reportFull,
    lastUserMessageIndex,
    userMessageCount,
    foldedThrough: Math.max(ledger.foldedThrough, foldedThrough),
    foldedAt
  }
}
