import { describe, expect, it } from 'vitest'
import type { TranscriptMessage } from '../ai-vault/transcripts/session-transcript-consumers'
import {
  createSessionSummaryEventDigester,
  type SessionSummarySourceEvent
} from './session-summary-event-digest'
import {
  mergeSessionSummaryMarkers,
  planSessionSummaryTimelineMarkers,
  projectSessionSummaryTimeline
} from './session-summary-timeline'

function call(name: string, target: string): TranscriptMessage {
  return { role: 'tool', text: `${name}: ${target}`, timestamp: null, toolKind: 'call' }
}

function result(text: string): TranscriptMessage {
  return { role: 'tool', text, timestamp: null, toolKind: 'result' }
}

function prose(role: 'user' | 'assistant', text: string): TranscriptMessage {
  return { role, text, timestamp: null }
}

function digest(messages: TranscriptMessage[]): SessionSummarySourceEvent[] {
  const digester = createSessionSummaryEventDigester()
  return messages.map((message) => digester.digest(message))
}

const OK_BODY = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
const FAILED_TEST = ['FAIL src/x.test.ts > adds a flag', 'Process exited with code 1'].join('\n')

/** A run of `count` reads, one of which fails when `failedAt` names it. */
function readRun(count: number, failedAt: number | null = null): TranscriptMessage[] {
  const messages: TranscriptMessage[] = []
  for (let index = 0; index < count; index += 1) {
    messages.push(call('Read', `/repo/src/f${index}.ts`))
    messages.push(result(index === failedAt ? FAILED_TEST : OK_BODY))
  }
  return messages
}

describe('planSessionSummaryTimelineMarkers', () => {
  it('anchors the reader’s message and a burst to transcript indexes', () => {
    const events = digest([prose('user', 'make the tests pass'), ...readRun(5, 2)])
    const markers = planSessionSummaryTimelineMarkers(events, 100)
    expect(markers).toEqual([
      { kind: 'user-input', text: 'make the tests pass', sourceIndex: 100 },
      { kind: 'tool-burst', text: '5 tool calls · Read 5 · 1 failed', sourceIndex: 101 },
      {
        kind: 'error',
        text: 'Read /repo/src/f2.ts · FAIL src/x.test.ts > adds a flag',
        sourceIndex: 105
      }
    ])
  })

  // Two or three reads happen between almost every assistant message, and a timeline of those is
  // the play-by-play this change exists to remove.
  it('leaves a run shorter than five calls out of the timeline', () => {
    const markers = planSessionSummaryTimelineMarkers(digest(readRun(4)), 0)
    expect(markers).toEqual([])
  })

  // `rg` exits 1 when nothing matched. That is an exit code, not evidence of a problem, and an
  // error row for it is noise the reader cannot act on.
  it('does not call a bare nonzero exit an error', () => {
    const events = digest([call('Grep', 'TODO'), result('no matches\nExit code: 1'), ...readRun(5)])
    const markers = planSessionSummaryTimelineMarkers(events, 0)
    expect(markers.filter((marker) => marker.kind === 'error')).toEqual([])
  })

  it('bounds the reader’s message it quotes', () => {
    const markers = planSessionSummaryTimelineMarkers(
      digest([prose('user', `${'x'.repeat(400)}\nsecond line`)]),
      0
    )
    expect(markers).toHaveLength(1)
    expect(markers[0].text).toHaveLength(200)
    expect(markers[0].text.endsWith('…')).toBe(true)
    expect(markers[0].text).not.toContain('second line')
  })
})

describe('mergeSessionSummaryMarkers', () => {
  // A re-fold of a range after a cache miss replans the same markers.
  it('keeps one marker per (kind, sourceIndex)', () => {
    const first = [{ kind: 'user-input' as const, text: 'a', sourceIndex: 3 }]
    const second = [{ kind: 'user-input' as const, text: 'a', sourceIndex: 3 }]
    expect(mergeSessionSummaryMarkers(first, second)).toHaveLength(1)
    expect(mergeSessionSummaryMarkers(first, [])).toEqual(first)
  })
})

describe('projectSessionSummaryTimeline', () => {
  it('orders facts and markers by index and derives ids from (kind, sourceIndex)', () => {
    const timeline = projectSessionSummaryTimeline(
      {
        done: [{ text: 'shipped', sourceIndex: 4 }],
        decisions: [{ text: 'chose a flag', sourceIndex: 2 }],
        blockers: []
      },
      [{ kind: 'user-input', text: 'go', sourceIndex: 1 }]
    )
    expect(timeline).toEqual([
      { id: 'user-input-1', kind: 'user-input', text: 'go', sourceIndex: 1 },
      { id: 'decision-2', kind: 'decision', text: 'chose a flag', sourceIndex: 2 },
      { id: 'milestone-4', kind: 'milestone', text: 'shipped', sourceIndex: 4 }
    ])
  })

  // A failed command is usually also what the extract wrote a blocker about, and two error rows
  // for one failure read as two problems.
  it('lets a blocker supersede the failure marker at the same index', () => {
    const timeline = projectSessionSummaryTimeline(
      { done: [], decisions: [], blockers: [{ text: 'the suite is red', sourceIndex: 7 }] },
      [{ kind: 'error', text: 'Bash npm test · FAIL x', sourceIndex: 7 }]
    )
    expect(timeline).toEqual([
      { id: 'error-7', kind: 'error', text: 'the suite is red', sourceIndex: 7 }
    ])
  })

  it('is a pure function of its inputs', () => {
    const facts = { done: [{ text: 'a', sourceIndex: 2 }], decisions: [], blockers: [] }
    const markers = [{ kind: 'user-input' as const, text: 'go', sourceIndex: 1 }]
    expect(projectSessionSummaryTimeline(facts, markers)).toEqual(
      projectSessionSummaryTimeline(facts, markers)
    )
  })
})
