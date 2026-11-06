// A ledger relayed from a paired host, coerced into this build's shape.
//
// Mixed versions are the normal case: a paired host updates on its own schedule. An older host
// relays a ledger whose facts are bare strings and which has no window boundary, and reading
// that as-is hides every fact (nothing compares greater than `undefined`) and renders an object
// as a React child. Coercing on arrival costs one pass and keeps both directions readable.
import type {
  SessionSummaryFact,
  SessionSummaryFoldGap,
  SessionSummaryFullReport,
  SessionSummaryLedger,
  SessionSummaryReport,
  SessionSummaryReportSection,
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

function coerceReport(value: unknown): SessionSummaryReport | null {
  if (!isRecord(value) || typeof value.text !== 'string') {
    return null
  }
  return {
    text: value.text,
    through: typeof value.through === 'number' ? value.through : 0
  }
}

function coerceSections(value: unknown): SessionSummaryReportSection[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: SessionSummaryReportSection[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.text !== 'string') {
      continue
    }
    out.push({
      id: typeof entry.id === 'string' ? entry.id : `s${out.length}`,
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : 'Work',
      text: entry.text,
      through: coerceCount(entry.through)
    })
  }
  return out
}

/**
 * The whole-session report from either version.
 *
 * A host older than the structured shape relays `{ text, through }`; a newer one relays
 * `{ headline, sections, through }`. Reading the old one as the new shape would show no prose at
 * all, and reading the new one as the old shape would render an object as a React child.
 */
function coerceFullReport(value: unknown): SessionSummaryFullReport | null {
  if (!isRecord(value)) {
    return null
  }
  const through = coerceCount(value.through)
  const sections = coerceSections(value.sections)
  const headline = typeof value.headline === 'string' ? value.headline.trim() : ''
  if (sections.length > 0 || headline) {
    return {
      headline,
      sections,
      through,
      text: typeof value.text === 'string' ? value.text : headline
    }
  }
  if (typeof value.text === 'string' && value.text.trim()) {
    return {
      headline: value.text.trim(),
      sections: [],
      through,
      text: value.text
    }
  }
  return null
}

function coerceFoldGap(value: unknown): SessionSummaryFoldGap | null {
  if (!isRecord(value)) {
    return null
  }
  const totalChunks = coerceCount(value.totalChunks)
  if (totalChunks <= 0) {
    return null
  }
  return { completedChunks: coerceCount(value.completedChunks), totalChunks }
}

function coerceGaps(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : []
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
    reportFull: coerceFullReport(value.reportFull),
    // An older host has no boundary: everything it folded is "the session", so a null boundary
    // shows all of it rather than hiding it behind a window that does not exist there.
    lastUserMessageIndex: coerceIndex(value.lastUserMessageIndex),
    userMessageCount: coerceCount(value.userMessageCount),
    foldedThrough: coerceCount(value.foldedThrough),
    foldedAt: typeof value.foldedAt === 'number' ? value.foldedAt : null,
    // An older host trims nothing, so every entry it holds starts at position zero.
    timelineBase: coerceCount(value.timelineBase),
    foldGap: coerceFoldGap(value.foldGap),
    gaps: coerceGaps(value.gaps)
  }
}
