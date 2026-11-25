import { defineFixture } from '../../component-fixtures/component-fixture'
import type {
  SessionSummaryLedger,
  SessionSummaryQuestion,
  SessionSummarySnapshot
} from '../../../../shared/session-summary-types'
import { SessionSummaryLedgerView } from './session-summary-ledger-view'
import { SessionSummaryQuestionComposer } from './session-summary-questions-view'

const ASKED = Date.UTC(2026, 10, 25, 12, 4)

const LEDGER: SessionSummaryLedger = {
  goal: { text: 'Add questions to the summary pane', sourceIndex: 0 },
  plan: [],
  inProgress: { text: 'Wiring the composer', sourceIndex: 8 },
  done: [{ text: 'Store questions beside the ledger', sourceIndex: 5 }],
  blockers: [],
  decisions: [{ text: 'Answer from the brief, not the transcript', sourceIndex: 3 }],
  timeline: [{ id: 't1', kind: 'milestone', text: 'Store landed', sourceIndex: 5 }],
  markers: [],
  reportSince: null,
  reportFull: {
    headline: 'Questions are stored and answered; the composer is being wired.',
    sections: [],
    through: 9,
    text: ''
  },
  lastUserMessageIndex: 0,
  userMessageCount: 1,
  foldedThrough: 9,
  foldedAt: ASKED,
  foldGap: null,
  gaps: []
}

const QUESTIONS: SessionSummaryQuestion[] = [
  {
    id: 'q1',
    text: 'Why answer from the brief?',
    askedAt: ASKED - 600_000,
    status: 'answered',
    answer: 'The store keeps only the ledger, so the brief is what the answer can cite [#3].',
    answeredAt: ASKED - 590_000
  },
  {
    id: 'q2',
    text: 'Did it touch the fold persist module?',
    askedAt: ASKED - 60_000,
    status: 'failed',
    error: 'session summary fold timed out'
  },
  { id: 'q3', text: 'What is left?', askedAt: ASKED, status: 'pending' }
]

const SNAPSHOT: SessionSummarySnapshot = {
  paneKey: 'tab:leaf',
  status: 'ready',
  facts: null,
  ledger: LEDGER,
  seenThrough: 0,
  fold: { running: false, completedChunks: 0, totalChunks: 0 },
  questions: QUESTIONS,
  canAsk: true
}

export const withQuestions = defineFixture({
  width: 340,
  render: () => (
    <div className="flex flex-col">
      <div className="px-4 py-3">
        <SessionSummaryLedgerView snapshot={SNAPSHOT} onRetryQuestion={() => {}} />
      </div>
      <SessionSummaryQuestionComposer canAsk hasBrief onAsk={() => {}} />
    </div>
  )
})

export const composerOnPairedHost = defineFixture({
  width: 340,
  render: () => <SessionSummaryQuestionComposer canAsk={false} hasBrief onAsk={() => {}} />
})
