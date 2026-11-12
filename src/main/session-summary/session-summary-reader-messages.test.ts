import { describe, expect, it } from 'vitest'
import { foldSessionSummaryEvents, type SessionFoldBrain } from './session-summary-fold'
import { emptySessionSummaryLedger } from './session-summary-ledger'

const REPORT_PROMPT_PREFIX = 'You write the progress report'

/** A brain that answers chunk extracts with JSON and the report step with a report. */
const brain: SessionFoldBrain = {
  complete: async ({ prompt }) =>
    prompt.startsWith(REPORT_PROMPT_PREFIX)
      ? JSON.stringify({
          headline: 'a headline',
          section: { title: 'a phase', text: 'something happened' },
          startNew: false,
          since: 'since text'
        })
      : JSON.stringify({ done: ['ok'] })
}

// #387: an injected turn arrives as a user record too, so counting every user event made `/model`
// the reader's "last message" — and the pane hides everything before that boundary, including the
// prompt they actually typed.
describe('reader messages after a fold', () => {
  it('counts only the reader’s own prompts and anchors the boundary on one', async () => {
    const result = await foldSessionSummaryEvents({
      brain,
      ledger: emptySessionSummaryLedger(),
      events: [
        { role: 'user', text: 'real prompt', timestamp: null },
        { role: 'assistant', text: 'working', timestamp: null },
        { role: 'user', text: '<command-name>/model</command-name>', timestamp: null },
        {
          role: 'user',
          text: '<local-command-stdout>Set model to opus</local-command-stdout>',
          timestamp: null
        },
        { role: 'assistant', text: 'done', timestamp: null }
      ],
      signal: new AbortController().signal
    })
    expect(result.ledger.userMessageCount).toBe(1)
    expect(result.ledger.lastUserMessageIndex).toBe(0)
    expect(result.ledger.timeline.filter((entry) => entry.kind === 'user-input')).toEqual([
      { id: 'user-input-0', kind: 'user-input', text: 'real prompt', sourceIndex: 0 }
    ])
  })
})
