// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionSummaryQuestion,
  SessionSummarySnapshot
} from '../../../../shared/session-summary-types'
import { useSessionSummaryQuestions } from './use-session-summary-questions'

const PANE = 'tab-1:leaf'

function snapshot(questions: SessionSummaryQuestion[]): SessionSummarySnapshot {
  return {
    paneKey: PANE,
    status: 'ready',
    facts: null,
    ledger: null,
    seenThrough: 0,
    fold: { running: false, completedChunks: 0, totalChunks: 0 },
    questions,
    canAsk: true
  }
}

function deferred(): {
  promise: Promise<SessionSummarySnapshot>
  resolve: (value: SessionSummarySnapshot) => void
  reject: (error: Error) => void
} {
  let resolve: (value: SessionSummarySnapshot) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<SessionSummarySnapshot>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// The row the reader just sent is the only evidence the question exists until main answers, so
// it must show at once, survive a refused call, and give way to the shared snapshot once settled.
describe('useSessionSummaryQuestions', () => {
  it('shows a pending row before the call resolves, then the snapshot takes over', async () => {
    const call = deferred()
    const ask = vi.fn(() => call.promise)
    vi.stubGlobal('api', { sessionSummary: { ask } })
    const { result, rerender } = renderHook(
      ({ current }) => useSessionSummaryQuestions(PANE, current),
      { initialProps: { current: snapshot([]) } }
    )

    act(() => result.current.ask('  Why?  '))

    expect(result.current.questions).toMatchObject([{ text: 'Why?', status: 'pending' }])
    const id = result.current.questions[0]?.id ?? ''
    expect(ask).toHaveBeenCalledWith({ paneKey: PANE, questionId: id, text: 'Why?' })
    const answered: SessionSummaryQuestion = {
      id,
      text: 'Why?',
      askedAt: 1,
      status: 'answered',
      answer: 'Because.'
    }
    await act(async () => call.resolve(snapshot([answered])))
    rerender({ current: snapshot([answered]) })

    expect(result.current.questions).toEqual([answered])
  })

  it('keeps a refused question as a failed row the reader can retry', async () => {
    const ask = vi.fn(async () => {
      throw new Error("Error invoking remote method 'sessionSummary:ask': Error: ask-busy")
    })
    vi.stubGlobal('api', { sessionSummary: { ask } })
    const { result } = renderHook(() => useSessionSummaryQuestions(PANE, snapshot([])))

    act(() => result.current.ask('Why?'))

    await waitFor(() => expect(result.current.questions[0]?.status).toBe('failed'))
    expect(result.current.questions[0]?.error).toContain('ask-busy')
  })

  it('drops an accepted row once the snapshot no longer carries it', async () => {
    const ask = vi.fn(async () => snapshot([]))
    vi.stubGlobal('api', { sessionSummary: { ask } })
    const { result } = renderHook(() => useSessionSummaryQuestions(PANE, snapshot([])))

    act(() => result.current.ask('Why?'))

    await waitFor(() => expect(result.current.questions).toEqual([]))
  })
})
