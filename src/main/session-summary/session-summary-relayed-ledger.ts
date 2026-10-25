// A ledger relayed from a paired host, coerced into this build's shape.
//
// Mixed versions are the normal case: a paired host updates on its own schedule. An older host
// relays a ledger whose facts are bare strings and which has no window boundary, and reading
// that as-is hides every fact (nothing compares greater than `undefined`) and renders an object
// as a React child. Coercing on arrival costs one pass and keeps both directions readable.
import type {
  SessionSummaryFact,
  SessionSummaryLedger,
  SessionSummaryTimelineEntry
} from '../../shared/session-summary-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A fact from either version: a bare string, or `{ text, sourceIndex }`. */
function coerceFact(value: unknown): SessionSummaryFact | null {
  if (typeof value === 'string') {
    return value.trim() ? { text: value, sourceIndex: null } : null
  }
  if (!isRecord(value) || typeof value.text !== 'string' || !value.text.trim()) {
    return null
  }
  const index = value.sourceIndex
  return {
    text: value.text,
    sourceIndex: typeof index === 'number' && Number.isFinite(index) ? Math.floor(index) : null
  }
}

function coerceFactList(value: unknown): SessionSummaryFact[] {
  return Array.isArray(value)
    ? value.map(coerceFact).filter((fact): fact is SessionSummaryFact => fact !== null)
    : []
}

function coerceTimeline(value: unknown): SessionSummaryTimelineEntry[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is SessionSummaryTimelineEntry => {
        if (!isRecord(entry)) {
          return false
        }
        return (
          typeof entry.id === 'string' &&
          typeof entry.kind === 'string' &&
          typeof entry.text === 'string' &&
          typeof entry.sourceIndex === 'number'
        )
      })
    : []
}

function coerceReport(value: unknown): SessionSummaryLedger['reportFull'] {
  if (!isRecord(value) || typeof value.text !== 'string') {
    return null
  }
  return {
    text: value.text,
    through: typeof value.through === 'number' ? value.through : 0
  }
}

function coerceCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function coerceIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null
}

/**
 * The ledger a host relayed, in this build's shape.
 *
 * Null when there is no ledger to show; the snapshot's own `ledger: null` then means "no brief".
 */
export function coerceRelayedLedger(value: unknown): SessionSummaryLedger | null {
  if (!isRecord(value)) {
    return null
  }
  return {
    goal: coerceFact(value.goal),
    plan: coerceFactList(value.plan),
    inProgress: coerceFact(value.inProgress),
    done: coerceFactList(value.done),
    blockers: coerceFactList(value.blockers),
    decisions: coerceFactList(value.decisions),
    timeline: coerceTimeline(value.timeline),
    reportSince: coerceReport(value.reportSince),
    reportFull: coerceReport(value.reportFull),
    // An older host has no boundary: everything it folded is "the session", so a null boundary
    // shows all of it rather than hiding it behind a window that does not exist there.
    lastUserMessageIndex: coerceIndex(value.lastUserMessageIndex),
    userMessageCount: coerceCount(value.userMessageCount),
    foldedThrough: coerceCount(value.foldedThrough),
    foldedAt: typeof value.foldedAt === 'number' ? value.foldedAt : null
  }
}
