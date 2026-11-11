// The fold's second phase: the prose a reader actually reads.
//
// Kept apart from the fold protocol because it answers a different question — the chunks turn a
// transcript into facts, this turns facts into a brief a colleague would give — and because prose
// has to be *rewritten*, not accumulated, to stay short.
//
// Why it runs as a chain rather than once per fold: extraction already scales (one bounded call per
// chunk), but a single report call over a days-long session is bounded only by cutting its input,
// which is how the "full" report came to describe the tail of the session and nothing before it.
// Rewriting every group of chunks, carrying the previous report forward, keeps each call's input
// bounded *and* coverage complete. It also means a group that fails is caught up by the next fold,
// because the report's position on the transcript is what says what it has covered.
import type {
  SessionSummaryFact,
  SessionSummaryFullReport,
  SessionSummaryLedger,
  SessionSummaryLedgerDelta,
  SessionSummaryReport
} from '../../shared/session-summary-types'
import {
  applySessionSummaryReportSection,
  type SessionSummaryReportReply
} from './session-summary-report-sections'
import {
  buildSessionSummaryReportPrompt,
  parseSessionSummaryReportReply,
  type SessionSummaryReportInput
} from './session-summary-report-prompt'

export {
  applySessionSummaryReportSection,
  buildSessionSummaryReportPrompt,
  parseSessionSummaryReportReply
}
export type { SessionSummaryReportInput, SessionSummaryReportReply }
import type { SessionFoldBrain } from './session-summary-fold'

/**
 * Most report calls one fold may make.
 *
 * Why capped: each call is sequential (it carries the previous report forward), so the report phase
 * would otherwise dominate a long fold's wall clock. A 5,000-event session is ~40 chunks, which this
 * splits into eight groups of five.
 */
const REPORT_MAX_CALLS = 8

/**
 * Transcript messages a report group must span before the run is split into more than one.
 *
 * Matches the chunk budget: a group is a handful of chunks, and a range smaller than one chunk's
 * worth of messages is one phase however it is divided.
 */
const REPORT_GROUP_MIN_SPAN_EVENTS = 120

/**
 * A run that spans more than one group opens a section per group instead of rewriting the last one.
 *
 * Why the code decides and not the model: coverage is the property this whole change exists for, and
 * a model that folded three days of work into one 60-word paragraph would lose the beginning of it.
 * A group boundary *is* a phase boundary, so a long fold yields one section per group; a small
 * incremental fold is a single group, and rewriting the open section is exactly what it should do.
 */
function sectionPerGroup(groupCount: number): boolean {
  return groupCount > 1
}

/** The facts whose provenance falls inside one report group. */
function batchForRange(
  ledger: SessionSummaryLedger,
  from: number,
  to: number,
  includeTo: boolean
): SessionSummaryLedgerDelta {
  const inRange = (index: number | null): boolean => {
    // A fact with no provenance can only belong to the session's first report: it was written by a
    // cache that predates indexes, and every later group would otherwise repeat it.
    if (index === null) {
      return from === 0
    }
    return index >= from && (includeTo ? index <= to : index < to)
  }
  const keep = (facts: readonly SessionSummaryFact[]): SessionSummaryFact[] =>
    facts.filter((fact) => inRange(fact.sourceIndex))
  return {
    ...(ledger.goal && inRange(ledger.goal.sourceIndex) ? { goal: ledger.goal } : {}),
    ...(ledger.inProgress && inRange(ledger.inProgress.sourceIndex)
      ? { inProgress: ledger.inProgress }
      : {}),
    plan: keep(ledger.plan),
    done: keep(ledger.done),
    blockers: keep(ledger.blockers),
    decisions: keep(ledger.decisions)
  }
}

/** Evenly split `[from, to)` into at most `REPORT_MAX_CALLS` groups. */
export function buildSessionSummaryReportGroups(
  from: number,
  to: number,
  maxCalls = REPORT_MAX_CALLS
): { from: number; to: number }[] {
  const span = to - from
  if (span <= 0) {
    return []
  }
  // Why a minimum span per group: the unit of a group is a chunk of transcript, not a message, so
  // a short range must stay one group — otherwise an incremental fold of forty messages would be
  // split eight ways and write eight phases out of one exchange.
  const callCount = Math.max(1, Math.min(maxCalls, Math.floor(span / REPORT_GROUP_MIN_SPAN_EVENTS)))
  const size = Math.ceil(span / callCount)
  const groups: { from: number; to: number }[] = []
  for (let start = from; start < to; start += size) {
    groups.push({ from: start, to: Math.min(to, start + size) })
  }
  return groups
}

/**
 * Rewrite the report from (previous report + the unfolded range of the ledger).
 *
 * A failure here keeps the previous report instead of failing the fold: the facts and the timeline
 * already landed, and a stale sentence is a smaller loss than losing the batch. Its `through` stays
 * where it was, which is what makes the next fold (or the catch-up on open) cover the gap.
 */
export async function rewriteSessionSummaryReports(args: {
  brain: SessionFoldBrain
  signal: AbortSignal
  /** The ledger before this fold: it holds the report to carry forward. */
  ledger: SessionSummaryLedger
  /** The ledger after this fold: it holds the facts to report on. */
  folded: SessionSummaryLedger
  windowRestarted: boolean
  userMessageCount: number
  lastUserMessageIndex: number | null
}): Promise<{ since: SessionSummaryReport | null; full: SessionSummaryFullReport | null }> {
  const previous = args.ledger.reportFull
  // Why the report's own position and not the fold's: a group that failed left `through` behind,
  // and that is exactly the range this run has to cover. Why zero when there is no report at all:
  // a first fold whose report phase failed advanced the cursor, and starting there would leave the
  // beginning of the session unreported for good — the failure this change exists to remove.
  const from = previous?.through ?? 0
  const to = args.folded.foldedThrough
  const groups = buildSessionSummaryReportGroups(from, to)
  if (groups.length === 0) {
    return { since: null, full: null }
  }
  let report = previous
  let since: SessionSummaryReport | null = null
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]
    const isLast = index === groups.length - 1
    const batch = batchForRange(args.folded, group.from, group.to, isLast)
    let reply: SessionSummaryReportReply | null = null
    try {
      const raw = await args.brain.complete({
        prompt: buildSessionSummaryReportPrompt({
          previous: report,
          delta: batch,
          windowRestarted: args.windowRestarted,
          userMessageCount: args.userMessageCount,
          lastUserMessageIndex: args.lastUserMessageIndex,
          writesSince: isLast
        }),
        signal: args.signal
      })
      args.signal.throwIfAborted()
      reply = parseSessionSummaryReportReply(raw)
    } catch (error) {
      if (args.signal.aborted) {
        throw error
      }
      reply = null
    }
    if (!reply) {
      // Stop the chain: the next fold resumes from the last report position, so nothing is lost.
      break
    }
    report = applySessionSummaryReportSection(
      report,
      reply,
      group.to,
      sectionPerGroup(groups.length)
    )
    if (isLast) {
      // Why enforced here and not trusted to the prompt: with one interaction the window is the
      // session, and two reports that say the same thing give the reader a switch with no meaning.
      since =
        args.userMessageCount <= 1 || !reply.since ? null : { text: reply.since, through: group.to }
    }
  }
  return { since, full: report }
}
