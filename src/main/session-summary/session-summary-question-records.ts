// The reader's questions as their store keeps them: bounded on write, validated on read.
//
// Why validated when the ledger is not: the ledger is a cache whose bad entry costs a re-fold,
// while a question is the reader's own words and its answer a paid model call — one malformed row
// must cost that row, never the rest of the file.
import {
  SESSION_SUMMARY_ANSWER_MAX_LENGTH,
  SESSION_SUMMARY_ASK_ERRORS,
  SESSION_SUMMARY_QUESTION_ID_MAX_LENGTH,
  SESSION_SUMMARY_QUESTION_MAX_LENGTH,
  SESSION_SUMMARY_QUESTIONS_PER_PANE,
  SESSION_SUMMARY_TEXT_MAX_LENGTH,
  type SessionSummaryQuestion
} from '../../shared/session-summary-types'

export type SessionSummaryQuestionsEntry = {
  /** The conversation these questions were asked about; a new one in the pane starts empty. */
  identity: { providerSessionId: string | null; transcriptPath: string | null }
  questions: SessionSummaryQuestion[]
  updatedAt: number
}

/** Panes with questions kept at once, oldest evicted first — the same ceiling as the ledgers. */
export const SESSION_SUMMARY_QUESTION_PANES_MAX = 200

/**
 * The whole file's ceiling. Every row is written on each change, and fifty full answers in each of
 * two hundred panes would be a 50 MB rewrite per question.
 */
export const SESSION_SUMMARY_QUESTION_FILE_MAX_BYTES = 2_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * At most the per-pane ceiling, oldest first. Settled rows go first: a pending row is an answer
 * already being paid for, and evicting it would throw that answer away when it lands.
 */
export function boundSessionSummaryQuestions(
  questions: readonly SessionSummaryQuestion[]
): SessionSummaryQuestion[] {
  const kept = [...questions]
  while (kept.length > SESSION_SUMMARY_QUESTIONS_PER_PANE) {
    const settled = kept.findIndex((question) => question.status !== 'pending')
    kept.splice(settled === -1 ? 0 : settled, 1)
  }
  return kept
}

function parseQuestion(value: unknown): SessionSummaryQuestion | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, text, status } = value
  const askedAt = finiteNumber(value.askedAt)
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > SESSION_SUMMARY_QUESTION_ID_MAX_LENGTH ||
    typeof text !== 'string' ||
    text.trim().length === 0 ||
    askedAt === undefined ||
    (status !== 'pending' && status !== 'answered' && status !== 'failed')
  ) {
    return null
  }
  const answer = typeof value.answer === 'string' && value.answer ? value.answer : undefined
  const answeredAt = finiteNumber(value.answeredAt)
  const through = finiteNumber(value.through)
  const error = typeof value.error === 'string' && value.error ? value.error : undefined
  const base = {
    id,
    text: clamp(text, SESSION_SUMMARY_QUESTION_MAX_LENGTH),
    askedAt,
    ...(through !== undefined ? { through } : {})
  }
  if (status === 'answered' && answer) {
    return {
      ...base,
      status: 'answered',
      answer: clamp(answer, SESSION_SUMMARY_ANSWER_MAX_LENGTH),
      ...(answeredAt !== undefined ? { answeredAt } : {})
    }
  }
  // Why a pending row reads back as failed: it was cut off by a quit, and nothing will finish it.
  // Failed keeps the question, so the reader can retry without retyping it.
  return {
    ...base,
    status: 'failed',
    error: clamp(
      status === 'failed' && error ? error : SESSION_SUMMARY_ASK_ERRORS.interrupted,
      SESSION_SUMMARY_TEXT_MAX_LENGTH
    )
  }
}

function parseIdentity(value: unknown): SessionSummaryQuestionsEntry['identity'] | null {
  if (!isRecord(value)) {
    return null
  }
  const { providerSessionId, transcriptPath } = value
  if (
    (providerSessionId !== null && typeof providerSessionId !== 'string') ||
    (transcriptPath !== null && typeof transcriptPath !== 'string')
  ) {
    return null
  }
  return { providerSessionId, transcriptPath }
}

/** Every well-formed pane entry in a stored `questions` map; anything else is dropped row by row. */
export function parseStoredSessionSummaryQuestions(
  value: unknown
): Record<string, SessionSummaryQuestionsEntry> {
  if (!isRecord(value)) {
    return {}
  }
  const entries: [string, SessionSummaryQuestionsEntry][] = []
  for (const [paneKey, raw] of Object.entries(value)) {
    if (!isRecord(raw) || !Array.isArray(raw.questions)) {
      continue
    }
    const identity = parseIdentity(raw.identity)
    const updatedAt = finiteNumber(raw.updatedAt)
    if (!identity || updatedAt === undefined) {
      continue
    }
    const questions = raw.questions
      .map(parseQuestion)
      .filter((question): question is SessionSummaryQuestion => question !== null)
    if (questions.length === 0) {
      continue
    }
    entries.push([
      paneKey,
      { identity, questions: boundSessionSummaryQuestions(questions), updatedAt }
    ])
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  return Object.fromEntries(entries.slice(0, SESSION_SUMMARY_QUESTION_PANES_MAX))
}
