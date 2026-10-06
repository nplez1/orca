// Pure ledger operations: model output normalization and delta application.
// Facts update in place; the timeline is append-only (entries are counted by
// index for "since you last looked", so rewrites would move the cursor).
import type {
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
    foldedThrough: 0,
    foldedAt: null
  }
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

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: string[] = []
  for (const item of value) {
    const text = normalizeText(item)
    if (text !== null && !out.includes(text)) {
      out.push(text)
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

/** Normalize an untrusted (model-produced) delta. Null when nothing usable is present. */
export function normalizeSessionSummaryDelta(value: unknown): SessionSummaryLedgerDelta | null {
  if (!isRecord(value)) {
    return null
  }
  const obj = value
  const delta: SessionSummaryLedgerDelta = {}
  if ('goal' in obj) {
    delta.goal = normalizeText(obj.goal)
  }
  if ('inProgress' in obj) {
    delta.inProgress = normalizeText(obj.inProgress)
  }
  if ('plan' in obj) {
    delta.plan = normalizeTextList(obj.plan)
  }
  if ('done' in obj) {
    delta.done = normalizeTextList(obj.done)
  }
  if ('blockers' in obj) {
    delta.blockers = normalizeTextList(obj.blockers)
  }
  if ('decisions' in obj) {
    delta.decisions = normalizeTextList(obj.decisions)
  }
  if ('timeline' in obj) {
    delta.timeline = normalizeTimeline(obj.timeline)
  }
  return Object.keys(delta).length > 0 ? delta : null
}

function mergeTextLists(...lists: string[][]): string[] {
  const out: string[] = []
  for (const list of lists) {
    for (const item of list) {
      if (!out.includes(item)) {
        out.push(item)
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
    if ('goal' in delta) {
      merged.goal = delta.goal
    }
    if ('inProgress' in delta) {
      merged.inProgress = delta.inProgress
    }
    if (delta.plan) {
      merged.plan = mergeTextLists(merged.plan ?? [], delta.plan)
    }
    if (delta.done) {
      merged.done = mergeTextLists(merged.done ?? [], delta.done)
    }
    if (delta.blockers) {
      merged.blockers = mergeTextLists(merged.blockers ?? [], delta.blockers)
    }
    if (delta.decisions) {
      merged.decisions = mergeTextLists(merged.decisions ?? [], delta.decisions)
    }
    if (delta.timeline) {
      merged.timeline = [...(merged.timeline ?? []), ...delta.timeline]
    }
  }
  return merged
}

/**
 * Apply a (merged) delta to a ledger. Pure: returns a new ledger whose
 * `foldedThrough` has advanced to `foldedThrough`. Absent delta fields leave
 * their ledger field untouched; explicit null clears the scalar.
 */
export function applySessionSummaryDelta(
  ledger: SessionSummaryLedger,
  delta: SessionSummaryLedgerDelta,
  foldedThrough: number,
  foldedAt: number
): SessionSummaryLedger {
  return {
    goal: 'goal' in delta ? (delta.goal ?? null) : ledger.goal,
    plan: delta.plan ? mergeTextLists(ledger.plan, delta.plan) : ledger.plan,
    inProgress: 'inProgress' in delta ? (delta.inProgress ?? null) : ledger.inProgress,
    done: delta.done ? mergeTextLists(ledger.done, delta.done) : ledger.done,
    blockers: delta.blockers ? mergeTextLists(ledger.blockers, delta.blockers) : ledger.blockers,
    decisions: delta.decisions
      ? mergeTextLists(ledger.decisions, delta.decisions)
      : ledger.decisions,
    timeline: [
      ...ledger.timeline,
      ...(delta.timeline ?? []).map((entry, index) => ({
        ...entry,
        id: `${entry.sourceIndex}-${entry.kind}-${ledger.timeline.length + index}`
      }))
    ],
    foldedThrough: Math.max(ledger.foldedThrough, foldedThrough),
    foldedAt
  }
}
