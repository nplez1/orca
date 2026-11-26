import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummarySnapshot } from '../../shared/session-summary-types'
import { SESSION_SUMMARY_FOLD_CANCELED_MESSAGE } from './session-summary-agent-cli-fold-brain'
import type { SessionFoldBrain } from './session-summary-fold'
import { resetSessionSummaryFoldSlotsForTests } from './session-summary-fold-slots'
import { SessionSummaryQuestionStore } from './session-summary-question-store'
import { SessionSummaryService, type SessionSummaryStatusEntry } from './session-summary-service'
import { SessionSummaryStore } from './session-summary-store'

const PANE = 'tab:leaf'
const QUESTION_PROMPT = "You answer a reader's question"

function entryFor(sessionId: string): SessionSummaryStatusEntry {
  return {
    agentType: 'claude',
    providerSession: { key: 'session_id', id: sessionId, transcriptPath: `/tmp/${sessionId}.jsonl` }
  }
}

type Answerer = (prompt: string, signal: AbortSignal) => Promise<string>

/**
 * A real store pair in a temp dir and a brain faked at the `createBrain` seam: the fold's own
 * prompts get a fixed extract, the question prompt goes to `answer`.
 */
function harness(directory: string): {
  service: SessionSummaryService
  store: SessionSummaryStore
  questions: SessionSummaryQuestionStore
  questionPrompts: string[]
  setAnswer: (next: Answerer) => void
  setEntry: (next: SessionSummaryStatusEntry) => void
  fold: () => Promise<void>
} {
  const store = new SessionSummaryStore(join(directory, 'session-summaries.json'))
  const questions = new SessionSummaryQuestionStore(join(directory, 'questions.json'))
  let entry = entryFor('s1')
  let answer: Answerer = async () => 'The answer.'
  const questionPrompts: string[] = []
  const brain: SessionFoldBrain = {
    complete: async ({ prompt, signal }) => {
      if (prompt.startsWith(QUESTION_PROMPT)) {
        questionPrompts.push(prompt)
        return await answer(prompt, signal)
      }
      if (prompt.startsWith('You write the progress report')) {
        return JSON.stringify({
          since: null,
          headline: 'Where it stands',
          section: { title: 'Phase', text: 'Work.' },
          startNew: false
        })
      }
      return JSON.stringify({ goal: 'Ship it', inProgress: 'Folding' })
    }
  }
  const events = Array.from({ length: 4 }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `message ${index}`,
    timestamp: null
  }))
  const updates: SessionSummarySnapshot[] = []
  const service = new SessionSummaryService({
    store,
    questions,
    readEvents: async ({ fromEventIndex }) => ({
      events: events.slice(fromEventIndex),
      totalEvents: events.length,
      retainedBytes: 0,
      overRetainedBudget: false,
      gaps: []
    }),
    getAgentStatusEntry: () => entry,
    createBrain: () => brain,
    now: () => 5_000
  })
  service.onUpdate((snapshot) => updates.push(snapshot))
  return {
    service,
    store,
    questions,
    questionPrompts,
    setAnswer: (next) => {
      answer = next
    },
    setEntry: (next) => {
      entry = next
    },
    fold: async () => {
      service.open({ paneKey: PANE })
      await vi.waitFor(() => expect(updates.some((update) => update.status === 'ready')).toBe(true))
    }
  }
}

function question(service: SessionSummaryService, id = 'q1') {
  return service.peek(PANE).questions?.find((row) => row.id === id)
}

describe('SessionSummaryService.ask', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-summary-ask-'))
  })

  afterEach(() => {
    resetSessionSummaryFoldSlotsForTests()
    rmSync(directory, { recursive: true, force: true })
  })

  // Acceptance criterion 5: a question is not the reader speaking to the agent, so the brief and
  // its "since your last message" window must not move.
  it('shows a pending row at once, then the answer, and leaves the ledger byte-identical', async () => {
    const h = harness(directory)
    await h.fold()
    const before = JSON.stringify(h.store.get(PANE))

    const asked = h.service.ask({ paneKey: PANE, questionId: 'q1', text: '  Why?  ' })

    expect(asked.questions).toEqual([
      { id: 'q1', text: 'Why?', askedAt: 5_000, status: 'pending', through: 4 }
    ])
    await vi.waitFor(() => expect(question(h.service)?.status).toBe('answered'))
    expect(question(h.service)).toMatchObject({ answer: 'The answer.', answeredAt: 5_000 })
    expect(h.questionPrompts[0]).toContain("The reader's question:\nWhy?")
    expect(JSON.stringify(h.store.get(PANE))).toBe(before)
  })

  it('keeps a failed question and retries it with the stored text', async () => {
    const h = harness(directory)
    await h.fold()
    h.setAnswer(async () => {
      throw new Error('brain down')
    })
    h.service.ask({ paneKey: PANE, questionId: 'q1', text: 'Why?' })
    await vi.waitFor(() => expect(question(h.service)?.status).toBe('failed'))
    expect(question(h.service)?.error).toBe('brain down')

    h.setAnswer(async () => 'Now it works.')
    h.service.ask({ paneKey: PANE, questionId: 'q1', text: 'something else' })

    await vi.waitFor(() => expect(question(h.service)?.status).toBe('answered'))
    expect(question(h.service)).toMatchObject({ text: 'Why?', askedAt: 5_000 })
    expect(h.questionPrompts).toHaveLength(2)
    expect(h.questionPrompts[1]).toContain("The reader's question:\nWhy?")
  })

  it('spends no second model call for an id already pending or answered', async () => {
    const h = harness(directory)
    await h.fold()
    let release: (answer: string) => void = () => {}
    h.setAnswer(() => new Promise<string>((resolve) => (release = resolve)))
    h.service.ask({ paneKey: PANE, questionId: 'q1', text: 'Why?' })
    h.service.ask({ paneKey: PANE, questionId: 'q1', text: 'Why?' })
    await vi.waitFor(() => expect(h.questionPrompts).toHaveLength(1))
    release('Done.')
    await vi.waitFor(() => expect(question(h.service)?.status).toBe('answered'))

    h.service.ask({ paneKey: PANE, questionId: 'q1', text: 'Why?' })

    expect(h.questionPrompts).toHaveLength(1)
  })

  it('refuses a third unanswered question on one pane', async () => {
    const h = harness(directory)
    await h.fold()
    h.setAnswer(() => new Promise<string>(() => {}))
    h.service.ask({ paneKey: PANE, questionId: 'q1', text: 'One?' })
    h.service.ask({ paneKey: PANE, questionId: 'q2', text: 'Two?' })

    expect(() => h.service.ask({ paneKey: PANE, questionId: 'q3', text: 'Three?' })).toThrow(
      'ask-busy'
    )
  })

  it('does not bring back an answer that lands after a new conversation took the pane', async () => {
    const h = harness(directory)
    await h.fold()
    let release: (answer: string) => void = () => {}
    h.setAnswer(() => new Promise<string>((resolve) => (release = resolve)))
    h.service.ask({ paneKey: PANE, questionId: 'q1', text: 'Why?' })
    await vi.waitFor(() => expect(h.questionPrompts).toHaveLength(1))

    h.setEntry(entryFor('s2'))
    h.service.open({ paneKey: PANE, sameViewer: true })
    expect(h.questions.get(PANE)).toBeNull()
    release('About the previous conversation.')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(h.questions.get(PANE)).toBeNull()
  })

  it('survives the last viewer leaving, and a quit aborts the answer in flight', async () => {
    const h = harness(directory)
    await h.fold()
    let release: (answer: string) => void = () => {}
    h.setAnswer(() => new Promise<string>((resolve) => (release = resolve)))
    h.service.ask({ paneKey: PANE, questionId: 'q1', text: 'Why?' })
    await vi.waitFor(() => expect(h.questionPrompts).toHaveLength(1))
    h.service.close({ paneKey: PANE, seenTimelineCount: 0 })
    release('Still paid for.')
    await vi.waitFor(() => expect(question(h.service)?.status).toBe('answered'))

    let aborted = false
    h.setAnswer(
      (_prompt, signal) =>
        new Promise<string>((_resolve, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error(SESSION_SUMMARY_FOLD_CANCELED_MESSAGE))
          })
        )
    )
    h.service.ask({ paneKey: PANE, questionId: 'q2', text: 'And?' })
    await vi.waitFor(() => expect(h.questionPrompts).toHaveLength(2))
    h.service.dispose()

    await vi.waitFor(() => expect(aborted).toBe(true))
    await vi.waitFor(() => expect(question(h.service, 'q2')?.error).toBe('ask-interrupted'))
  })

  it('refuses a pane that folds on a paired host', () => {
    const h = harness(directory)
    h.service.open({ paneKey: PANE, executionHostId: 'runtime:env-1' })

    expect(() => h.service.ask({ paneKey: PANE, questionId: 'q1', text: 'Why?' })).toThrow(
      'ask-paired-host'
    )
    expect(h.service.peek(PANE).canAsk).toBe(false)
  })
})
