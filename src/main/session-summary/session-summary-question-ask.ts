// A reader's question from submit to answer: record it, answer it, record the answer — and the
// rule that drops a pane's stored records when a different conversation takes it.
//
// Apart from the service so the service stays the lazy-lifecycle layer. Nothing here touches the
// ledger: a question is not the reader speaking to the agent, and one that moved
// `lastUserMessageIndex` would silently relabel the brief's "since your last message" window.
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control/ai/source-control-ai-operation-resolution'
import {
  SESSION_SUMMARY_TEXT_MAX_LENGTH,
  type SessionSummaryAskRequest,
  type SessionSummaryLedger,
  type SessionSummaryQuestion,
  type SessionSummarySessionRef,
  type SessionSummarySnapshot
} from '../../shared/session-summary-types'
import type { SessionFoldBrain } from './session-summary-fold'
import { answerSessionSummaryQuestion } from './session-summary-question-answer'
import {
  sessionSummaryIdentityChanged,
  sessionSummaryIdentityOf
} from './session-summary-session-ref'
import type { SessionSummaryTranscriptHost } from './session-summary-transcript-host'
import type { SessionSummaryStore, SessionSummaryStoreEntry } from './session-summary-store'

type Identity = SessionSummaryStoreEntry['identity']

export type SessionSummaryQuestionDeps = {
  store: SessionSummaryStore
  createBrain: (params: ResolvedSourceControlAiGenerationParams | null) => SessionFoldBrain
  now: () => number
  /** The brief the reader sees for the pane, which is what an answer is written from. */
  ledgerFor: (paneKey: string) => SessionSummaryLedger | null
  emit: (paneKey: string) => void
}

/** The pane's questions, when they were asked about the conversation `identity` names. */
export function sessionSummaryQuestionsFor(
  store: SessionSummaryStore,
  paneKey: string,
  identity: Identity
): SessionSummaryQuestion[] {
  const entry = store.getQuestions(paneKey)
  return entry && !sessionSummaryIdentityChanged(entry.identity, identity) ? entry.questions : []
}

/** A local snapshot with its questions, and whether one can be asked from it. */
export function withSessionSummaryQuestions(
  store: SessionSummaryStore,
  snapshot: SessionSummarySnapshot,
  identity: Identity | undefined
): SessionSummarySnapshot {
  return {
    ...snapshot,
    questions: identity ? sessionSummaryQuestionsFor(store, snapshot.paneKey, identity) : [],
    // Why the snapshot's ledger: it is the one the reader sees, and an answer must come from it.
    canAsk: snapshot.ledger !== null
  }
}

/**
 * Drops the stored records that describe a different conversation than the pane holds now: the
 * ledger, and the questions asked about it. A host-owned pane's records are that host's, so this
 * store never describes it at all.
 */
export function resetStaleSessionSummaryRecords(
  store: SessionSummaryStore,
  paneKey: string,
  host: SessionSummaryTranscriptHost,
  session: SessionSummarySessionRef
): void {
  // Why require an identity: this client clears status rows on reconnect, and an absent
  // one yields a null identity that differs from every stored one — deleting a good ledger.
  if (host.kind === 'runtime' || !session.providerSession?.id) {
    return
  }
  const current = sessionSummaryIdentityOf(session)
  const stored = store.get(paneKey)
  if (stored && sessionSummaryIdentityChanged(stored.identity, current)) {
    store.delete(paneKey)
  }
  // A new conversation in the pane must not inherit the previous one's questions.
  const questions = store.getQuestions(paneKey)
  if (questions && sessionSummaryIdentityChanged(questions.identity, current)) {
    store.deleteQuestions(paneKey)
  }
}

function writeQuestion(
  deps: SessionSummaryQuestionDeps,
  paneKey: string,
  identity: Identity,
  question: SessionSummaryQuestion
): void {
  const rows = sessionSummaryQuestionsFor(deps.store, paneKey, identity)
  const index = rows.findIndex((row) => row.id === question.id)
  const questions =
    index === -1 ? [...rows, question] : rows.map((row, at) => (at === index ? question : row))
  deps.store.setQuestions(paneKey, { identity, questions, updatedAt: deps.now() })
}

/**
 * Records a question (or re-asks a failed one) and starts its answer, which is announced through
 * `emit` when it lands.
 *
 * Why the answer has its own signal and not the fold's: the last close aborts the fold, and a paid
 * answer must not be thrown away because the reader switched tabs.
 */
export function askSessionSummaryQuestion(
  deps: SessionSummaryQuestionDeps,
  request: SessionSummaryAskRequest,
  foldParams: ResolvedSourceControlAiGenerationParams | null
): void {
  const paneKey = request.paneKey
  const stored = deps.store.get(paneKey)
  const ledger = deps.ledgerFor(paneKey)
  if (!stored || !ledger) {
    throw new Error('There is no summary of this session to ask about yet.')
  }
  const previous = sessionSummaryQuestionsFor(deps.store, paneKey, stored.identity).find(
    (question) => question.id === request.questionId
  )
  // Idempotent: a second send of the same id must not spend a second model call.
  if (previous && previous.status !== 'failed') {
    return
  }
  const question: SessionSummaryQuestion = {
    id: request.questionId,
    text: previous?.text ?? request.text.trim(),
    askedAt: previous?.askedAt ?? deps.now(),
    status: 'pending',
    through: ledger.foldedThrough
  }
  writeQuestion(deps, paneKey, stored.identity, question)
  deps.emit(paneKey)
  void answer(deps, paneKey, stored.identity, question, ledger, foldParams)
}

async function answer(
  deps: SessionSummaryQuestionDeps,
  paneKey: string,
  identity: Identity,
  question: SessionSummaryQuestion,
  ledger: SessionSummaryLedger,
  foldParams: ResolvedSourceControlAiGenerationParams | null
): Promise<void> {
  let settled: SessionSummaryQuestion
  try {
    const text = await answerSessionSummaryQuestion({
      brain: deps.createBrain(foldParams),
      ledger,
      question: question.text,
      signal: new AbortController().signal
    })
    settled = { ...question, status: 'answered', answer: text, answeredAt: deps.now() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    settled = {
      ...question,
      status: 'failed',
      error: message.slice(0, SESSION_SUMMARY_TEXT_MAX_LENGTH)
    }
  }
  // Why only while the row is still there: a new conversation in the pane dropped it, and an answer
  // about the previous one must not reappear under the next.
  const rows = sessionSummaryQuestionsFor(deps.store, paneKey, identity)
  if (!rows.some((row) => row.id === question.id)) {
    return
  }
  writeQuestion(deps, paneKey, identity, settled)
  deps.emit(paneKey)
}
