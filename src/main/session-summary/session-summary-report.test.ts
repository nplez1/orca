import { describe, expect, it } from 'vitest'
import {
  buildSessionSummaryReportPrompt,
  parseSessionSummaryReports,
  rewriteReports
} from './session-summary-report'
import { emptySessionSummaryLedger } from './session-summary-ledger'
import type { SessionFoldBrain } from './session-summary-fold'

const input = {
  previousSince: 'old since',
  previousFull: 'old full',
  delta: {
    done: [{ text: 'flag parsed', sourceIndex: 44 }],
    blockers: [{ text: 'tests red', sourceIndex: 12 }]
  },
  timeline: [
    { kind: 'milestone' as const, text: 'early work', sourceIndex: 11 },
    { kind: 'error' as const, text: 'recent failure', sourceIndex: 45 }
  ],
  windowRestarted: true,
  userMessageCount: 3,
  lastUserMessageIndex: 40
}

function brain(answer: unknown): SessionFoldBrain {
  return { complete: async () => JSON.stringify(answer) }
}

describe('buildSessionSummaryReportPrompt', () => {
  // The batch straddles the reader's message, so the prompt has to name the boundary — without
  // it the two reports covered the same ground, which is what the reader asked them not to do.
  it('tells the model where the reader’s last message is', () => {
    const prompt = buildSessionSummaryReportPrompt(input)
    expect(prompt).toContain('[#40]')
    expect(prompt).toContain('spoken to the agent 3 times')
    expect(prompt).toContain('old full')
  })

  it('asks for a single report when the reader has spoken once', () => {
    const prompt = buildSessionSummaryReportPrompt({ ...input, userMessageCount: 1 })
    expect(prompt).toContain('set "since" to null')
  })

  it('bounds the timeline so a long backlog cannot grow the prompt', () => {
    const timeline = Array.from({ length: 200 }, (_, index) => ({
      kind: 'milestone' as const,
      text: `entry ${index} ${'x'.repeat(400)}`,
      sourceIndex: index
    }))
    const prompt = buildSessionSummaryReportPrompt({ ...input, timeline })
    expect(prompt).toContain('entry 199')
    expect(prompt).not.toContain('entry 100 ')
    expect(prompt.length).toBeLessThan(20_000)
  })
})

describe('parseSessionSummaryReports', () => {
  it('accepts a null since as an answer, not a miss', () => {
    expect(parseSessionSummaryReports('{"since": null, "full": "f"}', 7)).toEqual({
      since: null,
      full: { text: 'f', through: 7 }
    })
  })

  it('rejects a reply with no full report', () => {
    expect(parseSessionSummaryReports('{"since": "s"}', 7)).toBeNull()
    expect(parseSessionSummaryReports('not json', 7)).toBeNull()
  })
})

describe('rewriteReports', () => {
  const ledger = emptySessionSummaryLedger()

  it('writes both reports', async () => {
    const reports = await rewriteReports({
      brain: brain({ since: 's', full: 'f' }),
      signal: new AbortController().signal,
      ledger,
      merged: {},
      through: 5,
      windowRestarted: false,
      userMessageCount: 3,
      lastUserMessageIndex: 4
    })
    expect(reports).toEqual({
      since: { text: 's', through: 5 },
      full: { text: 'f', through: 5 }
    })
  })

  // One interaction means the window is the session: two near-identical reports would give the
  // reader a switch with no meaning, so the split is enforced here and not trusted to the model.
  it('drops "since" when the reader has spoken only once', async () => {
    const reports = await rewriteReports({
      brain: brain({ since: 'same thing', full: 'f' }),
      signal: new AbortController().signal,
      ledger,
      merged: {},
      through: 5,
      windowRestarted: false,
      userMessageCount: 1,
      lastUserMessageIndex: 0
    })
    expect(reports?.since).toBeNull()
    expect(reports?.full.text).toBe('f')
  })

  // A stale sentence is a smaller loss than losing the batch: the caller keeps the old reports.
  it('returns null when the rewrite fails', async () => {
    const reports = await rewriteReports({
      brain: {
        complete: async () => {
          throw new Error('cli failed')
        }
      },
      signal: new AbortController().signal,
      ledger,
      merged: {},
      through: 5,
      windowRestarted: true,
      userMessageCount: 3,
      lastUserMessageIndex: 4
    })
    expect(reports).toBeNull()
  })
})
