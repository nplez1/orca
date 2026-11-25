import { useCallback, useMemo, useState } from 'react'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import type {
  SessionSummaryQuestion,
  SessionSummarySnapshot
} from '../../../../shared/session-summary-types'

/** A row this window is showing ahead of the snapshot that will carry it. */
type LocalQuestion = { question: SessionSummaryQuestion; settled: boolean }

export type SessionSummaryQuestionsView = {
  questions: SessionSummaryQuestion[]
  /** This window has a way to ask at all; a paired browser client does not yet. */
  askAvailable: boolean
  /** There is a brief to ask about, and this process can answer for it. */
  canAsk: boolean
  ask: (text: string) => void
  retry: (question: SessionSummaryQuestion) => void
}

/**
 * The pane's questions: the snapshot's list, with the rows this window just sent shown before
 * the snapshot carries them.
 *
 * Why the id is chosen here: the row on screen before the call resolves must be the row the
 * answer lands on, and two windows of the same pane must agree on which row that is.
 */
export function useSessionSummaryQuestions(
  paneKey: string,
  snapshot: SessionSummarySnapshot | null
): SessionSummaryQuestionsView {
  const [local, setLocal] = useState<Record<string, LocalQuestion>>({})
  const askAvailable = typeof window.api?.sessionSummary?.ask === 'function'

  const send = useCallback(
    (question: SessionSummaryQuestion): void => {
      const ask = window.api?.sessionSummary?.ask
      if (!ask) {
        return
      }
      setLocal((current) => ({ ...current, [question.id]: { question, settled: false } }))
      ask({ paneKey, questionId: question.id, text: question.text })
        .then(() => {
          setLocal((current) => {
            const entry = current[question.id]
            return entry ? { ...current, [question.id]: { ...entry, settled: true } } : current
          })
        })
        .catch((error: unknown) => {
          // Why kept as a failed row: the question is the reader's own words, and a refused call
          // must leave something to retry rather than a silently vanished question.
          setLocal((current) => ({
            ...current,
            [question.id]: {
              settled: true,
              question: {
                ...question,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error)
              }
            }
          }))
        })
    },
    [paneKey]
  )

  const ask = useCallback(
    (text: string): void => {
      send({
        id: createNonSecureContextUuid(),
        text: text.trim(),
        askedAt: Date.now(),
        status: 'pending'
      })
    },
    [send]
  )

  const retry = useCallback(
    (question: SessionSummaryQuestion): void => {
      send({ id: question.id, text: question.text, askedAt: question.askedAt, status: 'pending' })
    },
    [send]
  )

  const questions = useMemo(() => {
    const fromSnapshot = snapshot?.questions ?? []
    const known = new Set(fromSnapshot.map((question) => question.id))
    // Why the snapshot wins once the call settled: it is the one source every window shares, and
    // a local row kept past that point would hide the answer when it arrives.
    const shown = fromSnapshot.map((question) => {
      const entry = local[question.id]
      return entry && !entry.settled ? entry.question : question
    })
    for (const entry of Object.values(local)) {
      if (!known.has(entry.question.id)) {
        shown.push(entry.question)
      }
    }
    return shown.sort((a, b) => a.askedAt - b.askedAt)
  }, [local, snapshot?.questions])

  return {
    questions,
    askAvailable,
    canAsk: askAvailable && snapshot?.canAsk === true,
    ask,
    retry
  }
}
