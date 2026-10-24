// The fold's second phase: the two prose reports a reader actually reads.
//
// Kept apart from the fold protocol because it answers a different question — the chunks turn a
// transcript into facts, this turns facts into a brief a colleague would give — and because
// prose has to be *rewritten*, not accumulated, to stay short.
import type {
  SessionSummaryLedger,
  SessionSummaryLedgerDelta,
  SessionSummaryReport,
  SessionSummaryTimelineDeltaEntry
} from '../../shared/session-summary-types'
import type { SessionFoldBrain } from './session-summary-fold'
import { extractSessionSummaryJson } from './session-summary-json'

const REPORT_INSTRUCTIONS = `You write short progress reports about a coding session an agent is working on, the way a colleague would brief you.
Return a JSON object with exactly two keys, each a plain-text string (no markdown, no headings, no bullet lists):
- "since": 1-3 sentences (at most 60 words) on what happened since the reader's last message to the agent. Lead with the outcome; name a failure or a decision only if it matters. If nothing notable happened, say that in one sentence.
- "full": at most 5 sentences (at most 90 words) that stand on their own as a progress report on the whole session so far: where it stands, what is finished, what is next or blocking. Rewrite the previous full report to absorb the new work; never append to it.
- When the input says the reader has spoken to the agent only once, the two reports would cover the same ground: set "since" to null and put everything in "full".
Rules: respond with ONLY the JSON object. Never invent work, files, results or intentions that are not in the input. No greetings, no preamble.`

const REPORT_TEXT_MAX_CHARS = 1_200

/** The inputs a report rewrite needs: where we stand, and what just happened. */
export type SessionSummaryReportInput = {
  previousSince: string | null
  previousFull: string | null
  /** Facts folded in this batch, already normalized. */
  delta: SessionSummaryLedgerDelta
  /** Timeline entries folded in this batch. */
  timeline: readonly SessionSummaryTimelineDeltaEntry[]
  /** Whether the reader spoke to the agent inside this batch (the window just restarted). */
  windowRestarted: boolean
  /** User messages so far; 1 means the window covers the whole session. */
  userMessageCount: number
}

export function buildSessionSummaryReportPrompt(input: SessionSummaryReportInput): string {
  const lines: string[] = []
  lines.push(`Previous "full" report: ${input.previousFull ?? '(none)'}`)
  lines.push(`Previous "since" report: ${input.previousSince ?? '(none)'}`)
  if (input.windowRestarted) {
    lines.push(
      'The reader has sent a new message to the agent, so "since" starts from that message.'
    )
  }
  lines.push(
    input.userMessageCount <= 1
      ? 'The reader has spoken to the agent only once, so "since" and "full" cover the same ground: set "since" to null.'
      : `The reader has spoken to the agent ${input.userMessageCount} times.`
  )
  const facts: string[] = []
  const pushFact = (label: string, text: string, index: number | null): void => {
    facts.push(`${label}: ${text} [#${index ?? '?'}]`)
  }
  if (input.delta.goal) {
    pushFact('goal', input.delta.goal.text, input.delta.goal.sourceIndex)
  }
  if (input.delta.inProgress) {
    pushFact('in progress', input.delta.inProgress.text, input.delta.inProgress.sourceIndex)
  }
  for (const [label, list] of [
    ['plan', input.delta.plan],
    ['done', input.delta.done],
    ['blocker', input.delta.blockers],
    ['decision', input.delta.decisions]
  ] as const) {
    for (const fact of list ?? []) {
      pushFact(label, fact.text, fact.sourceIndex)
    }
  }
  lines.push('', 'Facts folded in this batch:', ...(facts.length > 0 ? facts : ['(none)']))
  lines.push(
    '',
    'Timeline of this batch:',
    ...(input.timeline.length > 0
      ? input.timeline.map((entry) => `[#${entry.sourceIndex} ${entry.kind}] ${entry.text}`)
      : ['(none)'])
  )
  return `${REPORT_INSTRUCTIONS}\n\n${lines.join('\n')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Parse the report rewrite; null when the model did not answer the full report. */
export function parseSessionSummaryReports(
  raw: string,
  through: number
): { since: SessionSummaryReport | null; full: SessionSummaryReport } | null {
  const value = extractSessionSummaryJson(raw)
  if (!isRecord(value)) {
    return null
  }
  const since = typeof value.since === 'string' ? value.since.trim() : ''
  const full = typeof value.full === 'string' ? value.full.trim() : ''
  if (!full) {
    return null
  }
  const clamp = (text: string): string =>
    text.length > REPORT_TEXT_MAX_CHARS ? `${text.slice(0, REPORT_TEXT_MAX_CHARS - 1)}…` : text
  return {
    // Null is a real answer, not a miss: one interaction means the window is the session.
    since: since ? { text: clamp(since), through } : null,
    full: { text: clamp(full), through }
  }
}

/**
 * Rewrite both reports from (previous reports + this batch).
 *
 * A failure here keeps the previous reports instead of failing the fold: the facts and the
 * timeline already landed, and a stale sentence is a smaller loss than losing the batch.
 */
export async function rewriteReports(args: {
  brain: SessionFoldBrain
  signal: AbortSignal
  ledger: SessionSummaryLedger
  merged: SessionSummaryLedgerDelta
  through: number
  windowRestarted: boolean
  userMessageCount: number
}): Promise<{ since: SessionSummaryReport | null; full: SessionSummaryReport } | null> {
  try {
    const raw = await args.brain.complete({
      prompt: buildSessionSummaryReportPrompt({
        previousSince: args.ledger.reportSince?.text ?? null,
        previousFull: args.ledger.reportFull?.text ?? null,
        delta: args.merged,
        timeline: args.merged.timeline ?? [],
        windowRestarted: args.windowRestarted,
        userMessageCount: args.userMessageCount
      }),
      signal: args.signal
    })
    args.signal.throwIfAborted()
    return parseSessionSummaryReports(raw, args.through)
  } catch (error) {
    if (args.signal.aborted) {
      throw error
    }
    return null
  }
}
