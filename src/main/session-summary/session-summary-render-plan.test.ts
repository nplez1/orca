import { describe, expect, it } from 'vitest'
import type { TranscriptMessage } from '../ai-vault/transcripts/session-transcript-consumers'
import {
  createSessionSummaryEventDigester,
  type SessionSummarySourceEvent
} from './session-summary-event-digest'
import {
  planSessionSummaryRenderItems,
  planSessionSummaryToolRuns
} from './session-summary-render-plan'
import { buildSessionSummaryChunks } from './session-summary-chunk-prompt'

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
const FAILED_TEST = [
  '> vitest run',
  '',
  'FAIL src/x.test.ts > adds a flag',
  'AssertionError: expected 1 to be 2',
  'Process exited with code 1'
].join('\n')

describe('planSessionSummaryToolRuns', () => {
  it('merges a call with the result that completes it and stops at prose', () => {
    const events = digest([
      prose('user', 'read it'),
      call('Read', '/repo/src/a.ts'),
      result(OK_BODY),
      prose('assistant', 'read'),
      call('Read', '/repo/src/b.ts'),
      result(OK_BODY)
    ])
    const runs = planSessionSummaryToolRuns(events)
    expect(runs.map((run) => [run.from, run.to])).toEqual([
      [1, 3],
      [4, 6]
    ])
    expect(runs[0].calls).toHaveLength(1)
    expect(runs[0].calls[0].label).toBe('Read /repo/src/a.ts')
    expect(runs[0].calls[0].failed).toBe(false)
  })

  // Agents issue parallel calls, so results arrive in call order after both calls. Merging by
  // adjacency alone would label the second call's line with the first result's numbers.
  it('does not merge a call with a result that belongs to another call', () => {
    const events = digest([
      call('Read', '/repo/src/a.ts'),
      call('Read', '/repo/src/b.ts'),
      result(OK_BODY),
      result(OK_BODY)
    ])
    const [run] = planSessionSummaryToolRuns(events)
    // Four events, four calls: nothing merges, so no result is quoted under another call's label.
    expect(run.calls.map((entry) => entry.to - entry.from)).toEqual([1, 1, 1, 1])
  })

  it('counts an orphan result as one call', () => {
    const events = digest([prose('user', 'go'), result(OK_BODY)])
    const [run] = planSessionSummaryToolRuns(events)
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0].label).toBe('tool result')
  })
})

describe('planSessionSummaryRenderItems', () => {
  // The one line the whole change is for: a run of calls reads as a count and a mix, and the
  // failure inside it stays expanded because that is the evidence a blocker is written from.
  it('collapses a run of calls into one burst line and keeps its failure expanded', () => {
    const events = digest([
      prose('user', 'make the tests pass'),
      call('Read', '/repo/src/a.ts'),
      result(OK_BODY),
      call('Bash', 'npm test'),
      result(FAILED_TEST),
      call('Grep', 'TODO'),
      result('12 matches'),
      prose('assistant', 'fixed it')
    ])
    const items = planSessionSummaryRenderItems(events)
    expect(items).toHaveLength(3)
    expect(items[1]).toEqual({
      from: 1,
      to: 7,
      role: 'tool',
      text: [
        '3 tool calls · Read 1, Bash 1, Grep 1 · 1 failed',
        '  #3 Bash npm test · FAIL src/x.test.ts > adds a flag'
      ].join('\n')
    })
  })

  // Nothing to collapse: one call between two prose events is one line, and it is the result's
  // line because that is the one that names the call *and* says what happened.
  it('renders a single call as its own line', () => {
    const events = digest([
      prose('user', 'read it'),
      call('Read', '/repo/src/a.ts'),
      result(OK_BODY),
      prose('assistant', 'read')
    ])
    const items = planSessionSummaryRenderItems(events)
    expect(items.map((item) => item.role)).toEqual(['user', 'tool', 'assistant'])
    expect(items[1]).toEqual({
      from: 1,
      to: 3,
      role: 'tool',
      text: expect.stringContaining('Read /repo/src/a.ts · 20 lines / ')
    })
    expect(items[1].text).toContain('ok')
  })

  it('names the first four tools and counts the rest', () => {
    const messages: TranscriptMessage[] = [prose('user', 'go')]
    for (const name of ['Read', 'Edit', 'Bash', 'Grep', 'Glob', 'Write']) {
      messages.push(call(name, 'x'), result(OK_BODY))
    }
    const burst = planSessionSummaryRenderItems(digest(messages)).find(
      (item) => item.role === 'tool'
    )
    expect(burst?.text).toBe('6 tool calls · Read 1, Edit 1, Bash 1, Grep 1, +2 more')
  })

  // An item is atomic for paging, so a run too long for one prompt has to become several items.
  it('splits a run too long for one bounded item', () => {
    const messages: TranscriptMessage[] = [prose('user', 'go')]
    for (let index = 0; index < 400; index += 1) {
      messages.push(call('Read', `/repo/src/file-${index}.ts`), result(OK_BODY))
    }
    const items = planSessionSummaryRenderItems(digest(messages))
    expect(items.length).toBeGreaterThan(1)
    for (const item of items) {
      expect(item.text.length).toBeLessThan(5_000)
    }
    expect(items.find((item) => item.role === 'tool')?.from).toBe(1)
    expect(items.at(-1)?.to).toBe(messages.length)
  })
})

describe('chunking over rendered lines', () => {
  /** 512 events: 400 tool events in 20 runs of 10 calls, plus 112 prose events. */
  function toolHeavyTranscript(): SessionSummarySourceEvent[] {
    const messages: TranscriptMessage[] = []
    for (let run = 0; run < 20; run += 1) {
      for (let index = 0; index < 5; index += 1) {
        messages.push(prose('assistant', `step ${run}-${index}`), prose('assistant', 'ok'))
      }
      for (let index = 0; index < 10; index += 1) {
        messages.push(call('Read', `/repo/src/file-${run}-${index}.ts`), result(OK_BODY))
      }
      messages.push(prose('user', `continue ${run}`))
    }
    return digest(messages.slice(0, 512))
  }

  // Acceptance: a tool-heavy session pages by what it renders, not by how many messages it holds.
  // Counting events kept this at five calls because 512 messages is five 120-event chunks.
  it('folds a tool-heavy 512-event transcript in two chunks', () => {
    const ranges = buildSessionSummaryChunks(planSessionSummaryRenderItems(toolHeavyTranscript()))
    expect(ranges).toHaveLength(2)
    expect(ranges.at(-1)?.to).toBe(512)
  })

  // A chunk boundary inside a run would cut a burst in half, and the two halves would each name a
  // count that never happened.
  it('never starts a chunk inside a rendered line', () => {
    const events = toolHeavyTranscript()
    const starts = new Set(planSessionSummaryRenderItems(events).map((item) => item.from))
    const ranges = buildSessionSummaryChunks(planSessionSummaryRenderItems(events), 500)
    expect(ranges.length).toBeGreaterThan(2)
    for (const range of ranges) {
      expect(range.from === 0 || starts.has(range.from)).toBe(true)
    }
  })
})
