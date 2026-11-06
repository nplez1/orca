import { describe, expect, it } from 'vitest'
import {
  applySessionSummaryReportSection,
  buildSessionSummaryReportGroups,
  buildSessionSummaryReportPrompt,
  parseSessionSummaryReportReply,
  rewriteSessionSummaryReports
} from './session-summary-report'
import { emptySessionSummaryLedger } from './session-summary-ledger'
import type { SessionFoldBrain } from './session-summary-fold'
import type {
  SessionSummaryFullReport,
  SessionSummaryLedger
} from '../../shared/session-summary-types'
import {
  SESSION_SUMMARY_REPORT_MAX_CHARS,
  SESSION_SUMMARY_REPORT_MAX_SECTIONS,
  SESSION_SUMMARY_REPORT_SECTION_MAX_CHARS
} from '../../shared/session-summary-types'

const input = {
  previous: null,
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
  lastUserMessageIndex: 40,
  writesSince: true
}

function brain(answer: (prompt: string, call: number) => unknown): SessionFoldBrain {
  let call = 0
  return {
    complete: async ({ prompt }) => {
      call += 1
      return JSON.stringify(answer(prompt, call))
    }
  }
}

function reply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headline: 'a headline',
    section: { title: 'a phase', text: 'something happened' },
    startNew: false,
    since: null,
    ...overrides
  }
}

function ledgerWith(overrides: Partial<SessionSummaryLedger>): SessionSummaryLedger {
  return { ...emptySessionSummaryLedger(), ...overrides }
}

describe('buildSessionSummaryReportPrompt', () => {
  // The batch straddles the reader's message, so the prompt has to name the boundary — without
  // it the two reports covered the same ground, which is what the reader asked them not to do.
  it('tells the model where the reader’s last message is', () => {
    const prompt = buildSessionSummaryReportPrompt(input)
    expect(prompt).toContain('[#40]')
    expect(prompt).toContain('spoken to the agent 3 times')
    expect(prompt).toContain('flag parsed')
  })

  it('asks for a single report when the reader has spoken once', () => {
    const prompt = buildSessionSummaryReportPrompt({ ...input, userMessageCount: 1 })
    expect(prompt).toContain('set "since" to null')
  })

  // Only the group that ends at the reader's last message writes "since"; an intermediate group
  // writing one would leave a sentence about the middle of the session labelled "since".
  it('tells a non-final group not to write the since report', () => {
    const prompt = buildSessionSummaryReportPrompt({ ...input, writesSince: false })
    expect(prompt).toContain('Do not write "since"')
  })

  it('carries the previous report forward and bounds the timeline', () => {
    const previous: SessionSummaryFullReport = {
      headline: 'old headline',
      sections: [{ id: 's1', title: 'old phase', text: 'old text', through: 12 }],
      through: 12,
      text: 'old headline\n\nold text'
    }
    const timeline = Array.from({ length: 200 }, (_, index) => ({
      kind: 'milestone' as const,
      text: `entry ${index} ${'x'.repeat(400)}`,
      sourceIndex: index
    }))
    const prompt = buildSessionSummaryReportPrompt({ ...input, previous, timeline })
    expect(prompt).toContain('old headline')
    expect(prompt).toContain('old phase')
    expect(prompt).toContain('entry 199')
    expect(prompt).not.toContain('entry 100 ')
    expect(prompt.length).toBeLessThan(30_000)
  })
})

describe('parseSessionSummaryReportReply', () => {
  it('accepts a headline and a section', () => {
    expect(parseSessionSummaryReportReply(JSON.stringify(reply()))).toEqual({
      headline: 'a headline',
      section: { title: 'a phase', text: 'something happened' },
      startNew: false,
      since: null
    })
  })

  it('reads a null since as an answer, not a miss', () => {
    expect(
      parseSessionSummaryReportReply('{"headline":"h","section":{"text":"t"}}')?.since
    ).toBeNull()
  })

  // Without a headline or a section there is nothing to render, and keeping the previous report is
  // a smaller loss than replacing it with an empty one.
  it('rejects a reply with no headline or no section', () => {
    expect(parseSessionSummaryReportReply(JSON.stringify({ section: { text: 't' } }))).toBeNull()
    expect(parseSessionSummaryReportReply(JSON.stringify({ headline: 'h' }))).toBeNull()
    expect(parseSessionSummaryReportReply('not json')).toBeNull()
  })

  it('clamps an over-long section and supplies a title', () => {
    const parsed = parseSessionSummaryReportReply(
      JSON.stringify({
        headline: 'h',
        section: { text: 'x'.repeat(SESSION_SUMMARY_REPORT_SECTION_MAX_CHARS * 2) }
      })
    )
    expect(parsed?.section.text).toHaveLength(SESSION_SUMMARY_REPORT_SECTION_MAX_CHARS)
    expect(parsed?.section.title).toBe('Work')
  })
})

describe('applySessionSummaryReportSection', () => {
  const parsed = {
    headline: 'h',
    section: { title: 'phase', text: 'text' },
    startNew: false,
    since: null
  }

  it('opens the first section and then rewrites it', () => {
    const first = applySessionSummaryReportSection(null, parsed, 10, false)
    expect(first.sections).toHaveLength(1)
    expect(first.through).toBe(10)
    const second = applySessionSummaryReportSection(
      first,
      { ...parsed, section: { title: 'phase', text: 'more' } },
      20,
      false
    )
    expect(second.sections).toHaveLength(1)
    expect(second.sections[0].text).toBe('more')
    expect(second.sections[0].through).toBe(20)
  })

  it('appends when the model or the group boundary opens a phase', () => {
    const first = applySessionSummaryReportSection(null, parsed, 10, false)
    const next = applySessionSummaryReportSection(
      first,
      { ...parsed, section: { title: 'next', text: 'later' } },
      20,
      true
    )
    expect(next.sections.map((section) => section.title)).toEqual(['phase', 'next'])
    expect(next.sections[1].through).toBe(20)
  })

  // A report that loses its beginning is the failure this change exists to prevent, so the ceiling
  // is enforced by merging the oldest pair rather than by dropping the newest.
  it('merges the oldest sections when the ceiling is reached', () => {
    let report: SessionSummaryFullReport | null = null
    for (let index = 0; index < SESSION_SUMMARY_REPORT_MAX_SECTIONS + 3; index += 1) {
      report = applySessionSummaryReportSection(
        report,
        {
          headline: 'h',
          section: { title: `p${index}`, text: `text ${index}` },
          startNew: false,
          since: null
        },
        index * 10,
        true
      )
    }
    expect(report?.sections).toHaveLength(SESSION_SUMMARY_REPORT_MAX_SECTIONS)
    // The newest phase survives intact; the compression landed on the far past.
    expect(report?.sections.at(-1)?.title).toBe(`p${SESSION_SUMMARY_REPORT_MAX_SECTIONS + 2}`)
    expect(report?.sections[0].title).toBe('p0')
  })

  it('keeps the whole report under its character ceiling', () => {
    let report: SessionSummaryFullReport | null = null
    for (let index = 0; index < 40; index += 1) {
      report = applySessionSummaryReportSection(
        report,
        {
          headline: 'h',
          section: {
            title: `p${index}`,
            text: 'y'.repeat(SESSION_SUMMARY_REPORT_SECTION_MAX_CHARS)
          },
          startNew: false,
          since: null
        },
        index * 10,
        true
      )
    }
    const chars = (report?.sections ?? []).reduce(
      (total, section) => total + section.text.length + section.title.length,
      0
    )
    expect(chars).toBeLessThanOrEqual(SESSION_SUMMARY_REPORT_MAX_CHARS)
  })

  it('derives the flat text an older client renders', () => {
    const report = applySessionSummaryReportSection(null, parsed, 10, false)
    expect(report.text).toContain('h')
    expect(report.text).toContain('text')
  })
})

describe('buildSessionSummaryReportGroups', () => {
  it('splits the unfolded range into at most eight contiguous groups', () => {
    const groups = buildSessionSummaryReportGroups(0, 5_000)
    expect(groups).toHaveLength(8)
    expect(groups[0].from).toBe(0)
    expect(groups.at(-1)?.to).toBe(5_000)
    for (let index = 0; index < groups.length - 1; index += 1) {
      expect(groups[index].to).toBe(groups[index + 1].from)
    }
  })

  it('has nothing to do over an empty range', () => {
    expect(buildSessionSummaryReportGroups(10, 10)).toEqual([])
    expect(buildSessionSummaryReportGroups(20, 10)).toEqual([])
  })
})

describe('rewriteSessionSummaryReports', () => {
  it('writes one section per group and only the last group’s since', async () => {
    const prompts: string[] = []
    const reports = await rewriteSessionSummaryReports({
      brain: brain((prompt, call) => {
        prompts.push(prompt)
        return reply({
          headline: `headline ${call}`,
          section: { title: `phase ${call}`, text: `work ${call}` },
          since: `since ${call}`
        })
      }),
      signal: new AbortController().signal,
      ledger: emptySessionSummaryLedger(),
      folded: ledgerWith({
        foldedThrough: 5_000,
        done: [
          { text: 'early', sourceIndex: 10 },
          { text: 'late', sourceIndex: 4_900 }
        ]
      }),
      windowRestarted: false,
      userMessageCount: 3,
      lastUserMessageIndex: 4_900
    })
    expect(prompts).toHaveLength(8)
    expect(reports.full?.sections).toHaveLength(8)
    expect(reports.full?.through).toBe(5_000)
    // Every group's phase survives: the first, the middle and the last all have a section.
    expect(reports.full?.sections[0].text).toBe('work 1')
    expect(reports.full?.sections.at(-1)?.text).toBe('work 8')
    expect(reports.since?.text).toBe('since 8')
    expect(reports.since?.through).toBe(5_000)
  })

  it('rewrites the open section when the fold is a single group', async () => {
    const previous: SessionSummaryFullReport = {
      headline: 'old',
      sections: [{ id: 's1', title: 'old phase', text: 'old text', through: 100 }],
      through: 100,
      text: 'old\n\nold text'
    }
    const reports = await rewriteSessionSummaryReports({
      brain: brain(() => reply({ section: { title: 'old phase', text: 'absorbed' } })),
      signal: new AbortController().signal,
      ledger: ledgerWith({ foldedThrough: 100, reportFull: previous }),
      folded: ledgerWith({ foldedThrough: 140, reportFull: previous }),
      windowRestarted: false,
      userMessageCount: 3,
      lastUserMessageIndex: 139
    })
    expect(reports.full?.sections).toHaveLength(1)
    expect(reports.full?.sections[0].text).toBe('absorbed')
    expect(reports.full?.through).toBe(140)
  })

  it('covers only the range the previous report did not reach', async () => {
    const previous: SessionSummaryFullReport = {
      headline: 'old',
      sections: [{ id: 's1', title: 'old phase', text: 'old text', through: 500 }],
      through: 500,
      text: 'old\n\nold text'
    }
    const prompts: string[] = []
    await rewriteSessionSummaryReports({
      brain: brain((prompt) => {
        prompts.push(prompt)
        return reply()
      }),
      signal: new AbortController().signal,
      ledger: ledgerWith({ foldedThrough: 500, reportFull: previous }),
      folded: ledgerWith({
        foldedThrough: 1_000,
        reportFull: previous,
        done: [
          { text: 'before the report', sourceIndex: 100 },
          { text: 'after it', sourceIndex: 510 }
        ]
      }),
      windowRestarted: false,
      userMessageCount: 3,
      lastUserMessageIndex: 900
    })
    // A fact from the already-reported range is not re-offered to the model.
    expect(prompts[0]).toContain('after it')
    expect(prompts[0]).not.toContain('before the report')
  })

  // A stale sentence is a smaller loss than losing the batch: the caller keeps the old report, and
  // its `through` staying behind is what makes the next fold cover the gap.
  it('stops the chain on a failed group and keeps the last good report', async () => {
    let call = 0
    const reports = await rewriteSessionSummaryReports({
      brain: {
        complete: async () => {
          call += 1
          if (call === 2) {
            throw new Error('cli failed')
          }
          return JSON.stringify(reply({ section: { title: 'phase', text: `work ${call}` } }))
        }
      },
      signal: new AbortController().signal,
      ledger: emptySessionSummaryLedger(),
      folded: ledgerWith({ foldedThrough: 5_000 }),
      windowRestarted: false,
      userMessageCount: 3,
      lastUserMessageIndex: 4_900
    })
    expect(reports.full?.sections).toHaveLength(1)
    expect(reports.full?.through).toBe(625)
  })

  it('has nothing to rewrite when the report already reaches the fold', async () => {
    const previous: SessionSummaryFullReport = {
      headline: 'h',
      sections: [],
      through: 10,
      text: 'h'
    }
    let calls = 0
    const reports = await rewriteSessionSummaryReports({
      brain: {
        complete: async () => {
          calls += 1
          return JSON.stringify(reply())
        }
      },
      signal: new AbortController().signal,
      ledger: ledgerWith({ foldedThrough: 10, reportFull: previous }),
      folded: ledgerWith({ foldedThrough: 10, reportFull: previous }),
      windowRestarted: false,
      userMessageCount: 3,
      lastUserMessageIndex: 9
    })
    expect(calls).toBe(0)
    expect(reports).toEqual({ since: null, full: null })
  })

  it('drops the since report when the reader has spoken only once', async () => {
    const reports = await rewriteSessionSummaryReports({
      brain: brain(() => reply({ since: 'same thing' })),
      signal: new AbortController().signal,
      ledger: emptySessionSummaryLedger(),
      folded: ledgerWith({ foldedThrough: 20 }),
      windowRestarted: false,
      userMessageCount: 1,
      lastUserMessageIndex: 0
    })
    expect(reports.since).toBeNull()
    expect(reports.full?.headline).toBe('a headline')
  })
})
