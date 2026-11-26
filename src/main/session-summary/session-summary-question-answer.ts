// One answer to a reader's question about a session, written by the brain that folds its summary.
//
// Why the brief and not the transcript: the store holds the ledger, never raw text, so the answer is
// built from the same facts the reader is looking at — cheap, and consistent with the summary.
// Transcript-grounded answers need a transcript re-read and are a deliberate later step (#280).
import {
  SESSION_SUMMARY_ANSWER_MAX_LENGTH,
  SESSION_SUMMARY_ASK_ERRORS,
  type SessionSummaryFact,
  type SessionSummaryLedger
} from '../../shared/session-summary-types'
import type { SessionFoldBrain } from './session-summary-fold'
import { withSessionSummaryFoldSlot } from './session-summary-fold-slots'

/** Newest timeline entries the prompt carries, so a days-long session still fits in one call. */
const TIMELINE_ENTRIES_IN_PROMPT = 80
/** Newest facts of each kind the prompt carries. */
const FACTS_PER_KIND_IN_PROMPT = 20

const QUESTION_INSTRUCTIONS = `You answer a reader's question about a coding session an agent is working on. The reader is not the agent: they are reading a brief of the session and want to understand it.
Answer only from the brief below. If the brief does not say, answer that it does not, and name what it does show that is closest.
Rules: plain prose, at most 150 words. Never invent work, files, results or intentions that are not in the brief. No headings, no greetings, no preamble. Cite the [#index] of the facts you rely on when it helps the reader find them.`

function factLines(label: string, facts: readonly SessionSummaryFact[]): string[] {
  return facts
    .slice(-FACTS_PER_KIND_IN_PROMPT)
    .map((fact) => `${label}: ${fact.text} [#${fact.sourceIndex ?? '?'}]`)
}

export function buildSessionSummaryQuestionPrompt(
  ledger: SessionSummaryLedger,
  question: string
): string {
  const lines: string[] = []
  if (ledger.goal) {
    lines.push(`Goal: ${ledger.goal.text} [#${ledger.goal.sourceIndex ?? '?'}]`)
  }
  if (ledger.reportFull) {
    lines.push(`Where it stands: ${ledger.reportFull.headline}`)
    for (const section of ledger.reportFull.sections) {
      lines.push(`- ${section.title} (through #${section.through}): ${section.text}`)
    }
  }
  if (ledger.reportSince) {
    lines.push(`Since the reader's last message to the agent: ${ledger.reportSince.text}`)
  }
  if (ledger.inProgress) {
    lines.push(`In progress: ${ledger.inProgress.text} [#${ledger.inProgress.sourceIndex ?? '?'}]`)
  }
  lines.push(
    ...factLines('Done', ledger.done),
    ...factLines('Blocker', ledger.blockers),
    ...factLines('Decision', ledger.decisions),
    ...factLines('Plan', ledger.plan)
  )
  const timeline = ledger.timeline.slice(-TIMELINE_ENTRIES_IN_PROMPT)
  if (timeline.length > 0) {
    const omitted = ledger.timeline.length - timeline.length
    lines.push(
      '',
      omitted > 0
        ? `Timeline, oldest first (the ${omitted} earliest entries are omitted):`
        : 'Timeline, oldest first:',
      ...timeline.map((entry) => `[#${entry.sourceIndex}] ${entry.kind}: ${entry.text}`)
    )
  }
  return `${QUESTION_INSTRUCTIONS}\n\nThe brief:\n${lines.join('\n') || '(empty)'}\n\nThe reader's question:\n${question}`
}

/**
 * Asks the brain, holding one of the process-wide fold slots so a burst of questions cannot spawn
 * agent CLIs past the ceiling the folds already respect.
 */
export async function answerSessionSummaryQuestion(args: {
  brain: SessionFoldBrain
  ledger: SessionSummaryLedger
  question: string
  signal: AbortSignal
}): Promise<string> {
  const raw = await withSessionSummaryFoldSlot(args.signal, () =>
    args.brain.complete({
      prompt: buildSessionSummaryQuestionPrompt(args.ledger, args.question),
      signal: args.signal
    })
  )
  const answer = raw.trim()
  if (!answer) {
    throw new Error(SESSION_SUMMARY_ASK_ERRORS.emptyAnswer)
  }
  return answer.length > SESSION_SUMMARY_ANSWER_MAX_LENGTH
    ? `${answer.slice(0, SESSION_SUMMARY_ANSWER_MAX_LENGTH - 1)}…`
    : answer
}
