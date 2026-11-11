// The report prompt and the reply parser: the two halves of talking to the model about prose.
//
// Apart from the chain that runs it because they change for different reasons — the prompt is a
// product decision, the chain is a scaling decision — and because a test can then assert the prompt
// without a model or a ledger.
import type {
  SessionSummaryFullReport,
  SessionSummaryLedgerDelta
} from '../../shared/session-summary-types'
import {
  SESSION_SUMMARY_REPORT_HEADLINE_MAX_CHARS,
  SESSION_SUMMARY_REPORT_SECTION_MAX_CHARS
} from '../../shared/session-summary-types'
import { extractSessionSummaryJson } from './session-summary-json'
import type { SessionSummaryReportReply } from './session-summary-report-sections'

const REPORT_INSTRUCTIONS = `You write the progress report for a coding session an agent is working on, the way a colleague would brief you.
Return a JSON object with exactly these keys:
- "headline": a plain-text string of at most 30 words that stands on its own and answers "where does this stand" for the whole session so far. Rewrite the previous headline to absorb the new work; never append to it.
- "section": an object { "title": string, "text": string }. "title" is at most 5 words naming this phase of the work. "text" is at most 60 words, plain prose, saying what happened in this phase. Rewrite the previous section if this batch continues it.
- "startNew": boolean — true when this batch is a new phase rather than a continuation of the previous section.
- "since": 1-3 sentences (at most 60 words) on what happened since the reader's last message to the agent, or null when the input tells you to.
Rules: respond with ONLY the JSON object. Never invent work, files, results or intentions that are not in the input. No markdown, no headings, no bullet lists, no greetings, no preamble.`

/** The `since` report is inherently short — it covers only the work after one message. */
const SINCE_MAX_CHARS = 600

export type SessionSummaryReportInput = {
  /** The report as it stands, or null on the first fold. */
  previous: SessionSummaryFullReport | null
  /** Ledger facts folded in this batch, already normalized. */
  delta: SessionSummaryLedgerDelta
  /** Whether the reader spoke to the agent inside this batch (the window just restarted). */
  windowRestarted: boolean
  /** User messages so far; 1 means the window covers the whole session. */
  userMessageCount: number
  /** The reader's last message, after this batch. */
  lastUserMessageIndex: number | null
  /** Whether this call is the last of the chain, and so also writes the "since" report. */
  writesSince: boolean
}

export function buildSessionSummaryReportPrompt(input: SessionSummaryReportInput): string {
  const lines: string[] = []
  lines.push(`Previous headline: ${input.previous?.headline ?? '(none)'}`)
  const sections = input.previous?.sections ?? []
  if (sections.length === 0) {
    lines.push('Previous sections: (none — this is the first phase)')
  } else {
    lines.push('Previous sections, oldest first:')
    for (const section of sections) {
      lines.push(`- ${section.title} (through #${section.through}): ${section.text}`)
    }
  }
  if (input.windowRestarted) {
    lines.push(
      'The reader has sent a new message to the agent, so "since" starts from that message.'
    )
  }
  const windowIndex = input.lastUserMessageIndex
  lines.push(
    !input.writesSince
      ? 'Do not write "since" for this batch: it is not the batch that ends at the reader\'s last message. Set it to null.'
      : input.userMessageCount <= 1 || windowIndex === null
        ? 'The reader has spoken to the agent only once, so "since" and the report cover the same ground: set "since" to null.'
        : `The reader has spoken to the agent ${input.userMessageCount} times. "since" covers only messages after [#${windowIndex}], their last message.`
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
  return `${REPORT_INSTRUCTIONS}\n\n${lines.join('\n')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Parse one link of the report chain; null when the model did not answer a usable report. */
export function parseSessionSummaryReportReply(raw: string): SessionSummaryReportReply | null {
  const value = extractSessionSummaryJson(raw)
  if (!isRecord(value)) {
    return null
  }
  const headline = typeof value.headline === 'string' ? value.headline.trim() : ''
  const section = isRecord(value.section) ? value.section : null
  const title = section && typeof section.title === 'string' ? section.title.trim() : ''
  const text = section && typeof section.text === 'string' ? section.text.trim() : ''
  if (!headline || !text) {
    return null
  }
  const since = typeof value.since === 'string' ? value.since.trim() : ''
  return {
    headline: clamp(headline, SESSION_SUMMARY_REPORT_HEADLINE_MAX_CHARS),
    section: {
      title: title || 'Work',
      text: clamp(text, SESSION_SUMMARY_REPORT_SECTION_MAX_CHARS)
    },
    startNew: value.startNew === true,
    since: since ? clamp(since, SINCE_MAX_CHARS) : null
  }
}
