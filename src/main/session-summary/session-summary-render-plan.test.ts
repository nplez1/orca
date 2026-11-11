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
import {
  buildSessionSummaryChunks,
  buildSessionSummaryChunkPrompt
} from './session-summary-chunk-prompt'

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

  // Agents issue parallel calls, so the transcript records call A, call B, result A, result B.
  // Pairing those by adjacency found no pair at all and counted two reads as four calls; pairing
  // by the digester's own id gives each call its own result, wherever it sits.
  it('merges parallel calls with their own results', () => {
    const events = digest([
      call('Read', '/repo/src/a.ts'),
      call('Read', '/repo/src/b.ts'),
      result('a\nb'),
      result('c')
    ])
    const [run] = planSessionSummaryToolRuns(events)
    expect(run.calls).toHaveLength(2)
    expect(run.calls.map((entry) => entry.from)).toEqual([0, 1])
    // The spans partition the run, so no chunk boundary can fall inside a call.
    expect(run.calls.map((entry) => entry.to)).toEqual([1, 4])
    expect(run.calls[0].text).toContain('2 lines')
    expect(run.calls[1].text).toContain('1 line /')
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
      burst: true,
      text: [
        '3 tool calls · Read 1, Bash 1, Grep 1 · 1 failed',
        '  #3 Bash npm test · exit 1 · FAIL src/x.test.ts > adds a flag'
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

  // A failure the digest cannot quote a line for is still the command a blocker is about, so it
  // has to stay attributable: a bare `exit 2` used to reach the extract as its own line, and a
  // burst that only counted it told the extract nothing about which command failed.
  it('expands a failure that has only an exit code', () => {
    const events = digest([
      prose('user', 'typecheck it'),
      call('Read', '/repo/src/a.ts'),
      result(OK_BODY),
      call('Bash', 'pnpm tc'),
      result('src/x.ts(3,1): error TS2322: Type is not assignable\nExit code: 2'),
      call('Grep', 'TS2322'),
      result('1 match')
    ])
    const items = planSessionSummaryRenderItems(events)
    expect(items[1].text).toBe(
      ['3 tool calls · Read 1, Bash 1, Grep 1 · 1 failed', '  #3 Bash pnpm tc · exit 2'].join('\n')
    )
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

describe('the chunk prompt anchor', () => {
  // A single call is anchored at its own message — the one a fact about it belongs to — and only
  // a burst names a span. Anchoring a lone call to a range made the prompt call it a burst.
  it('anchors a single call at its own message and a burst at its span', () => {
    const single = digest([prose('user', 'read it'), call('Read', '/a.ts'), result(OK_BODY)])
    expect(
      buildSessionSummaryChunkPrompt(planSessionSummaryRenderItems(single), { from: 0, to: 3 }, 0)
    ).toContain('[#1 tool] Read /a.ts · 20 lines / ')
    const burst = digest([
      prose('user', 'go'),
      ...Array.from({ length: 3 }, () => [call('Read', '/a.ts'), result(OK_BODY)]).flat()
    ])
    const prompt = buildSessionSummaryChunkPrompt(
      planSessionSummaryRenderItems(burst),
      { from: 0, to: 7 },
      0
    )
    expect(prompt).toContain('[#1-#6 tool] 3 tool calls · Read 3')
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
