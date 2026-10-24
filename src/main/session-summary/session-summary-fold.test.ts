import { describe, expect, it } from 'vitest'
import type { SessionSummaryLedgerDelta } from '../../shared/session-summary-types'
import { emptySessionSummaryLedger } from './session-summary-ledger'
import {
  buildSessionSummaryChunkPrompt,
  buildSessionSummaryChunks,
  extractSessionSummaryJson,
  foldSessionSummaryEvents,
  type SessionFoldBrain,
  type SessionSummarySourceEvent
} from './session-summary-fold'

function events(count: number): SessionSummarySourceEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `message ${index}`,
    timestamp: null
  }))
}

function jsonBrain(handler: (prompt: string) => unknown): SessionFoldBrain {
  return {
    complete: async ({ prompt }) => {
      // The fold's second phase asks for the two prose reports; a JSON-only brain would
      // otherwise count as a chunk call and answer with a chunk extract.
      if (prompt.startsWith('You write short progress reports')) {
        return JSON.stringify({ since: 'since text', full: 'full text' })
      }
      return JSON.stringify(handler(prompt))
    }
  }
}

describe('buildSessionSummaryChunks', () => {
  it('covers every event exactly once and respects the event cap', () => {
    const ranges = buildSessionSummaryChunks(events(90))
    expect(ranges[0]).toEqual({ from: 0, to: 40 })
    expect(ranges.at(-1)?.to).toBe(90)
    for (let index = 0; index < ranges.length - 1; index += 1) {
      expect(ranges[index].to).toBe(ranges[index + 1].from)
    }
  })

  it('splits by character budget on long events', () => {
    const long = Array.from({ length: 4 }, () => ({
      role: 'assistant' as const,
      text: 'y'.repeat(2000),
      timestamp: null
    }))
    const ranges = buildSessionSummaryChunks(long, 3000, 40)
    expect(ranges.length).toBeGreaterThan(1)
    expect(ranges.at(-1)?.to).toBe(4)
  })
})

describe('extractSessionSummaryJson', () => {
  it('reads fenced, bare, and prose-wrapped JSON', () => {
    const payload = { goal: 'g', note: 'has } brace and "quote" inside' }
    const json = JSON.stringify(payload)
    const fence = '````'
    const fenced = `${fence}json\n${json}\n${fence}`
    expect(extractSessionSummaryJson(fenced)).toEqual(payload)
    expect(extractSessionSummaryJson(json)).toEqual(payload)
    expect(extractSessionSummaryJson(`Sure! Here you go:\n${json}\nHope that helps.`)).toEqual(
      payload
    )
    expect(extractSessionSummaryJson('no json here')).toBeNull()
    expect(extractSessionSummaryJson('{broken')).toBeNull()
  })
})

describe('foldSessionSummaryEvents', () => {
  it('folds chunks in order and advances foldedThrough atomically', async () => {
    const seenPrompts: string[] = []
    const brain = jsonBrain((prompt) => {
      seenPrompts.push(prompt)
      return {
        done: [`chunk ${seenPrompts.length}`],
        timeline: [
          { kind: 'milestone', text: `m${seenPrompts.length}`, sourceIndex: seenPrompts.length }
        ]
      }
    })
    const result = await foldSessionSummaryEvents({
      brain,
      ledger: emptySessionSummaryLedger(),
      events: events(45),
      signal: new AbortController().signal
    })
    expect(result.totalChunks).toBe(2)
    expect(result.ledger.foldedThrough).toBe(45)
    // The slice's first message places a fact the extract did not index.
    expect(result.ledger.done).toEqual([
      { text: 'chunk 1', sourceIndex: 0 },
      { text: 'chunk 2', sourceIndex: 40 }
    ])
    expect(result.ledger.timeline.map((entry) => entry.text)).toEqual(['m1', 'm2'])
    // Both reports are written by the same second call, so the toggle costs nothing later.
    expect(result.ledger.reportFull?.text).toBe('full text')
    expect(result.ledger.reportSince?.text).toBe('since text')
    // events(45) alternates user/assistant from a user message: 23 reader messages.
    expect(result.ledger.userMessageCount).toBe(23)
    expect(result.ledger.lastUserMessageIndex).toBe(44)
    // The second chunk sees later message indexes than the first.
    expect(seenPrompts[0]).toContain('#0 user')
    expect(seenPrompts[1]).toContain('#40 ')
  })

  it('reuses cached chunk extracts instead of calling the brain again', async () => {
    const cacheStore = new Map<string, SessionSummaryLedgerDelta>()
    cacheStore.set('0-40', { done: [{ text: 'cached', sourceIndex: 0 }], timeline: [] })
    let calls = 0
    const brain = jsonBrain(() => {
      calls += 1
      return { done: ['fresh'] }
    })
    const result = await foldSessionSummaryEvents({
      brain,
      ledger: emptySessionSummaryLedger(),
      events: events(45),
      signal: new AbortController().signal,
      cache: {
        get: (key) => cacheStore.get(key),
        set: (key, delta) => {
          cacheStore.set(key, delta)
        }
      }
    })
    // One chunk extract, plus the report rewrite that is not a chunk call.
    expect(calls).toBe(1)
    expect(result.ledger.done).toEqual([
      { text: 'cached', sourceIndex: 0 },
      { text: 'fresh', sourceIndex: 40 }
    ])
  })

  it('applies nothing when a chunk extract fails', async () => {
    let calls = 0
    const brain: SessionFoldBrain = {
      complete: async () => {
        calls += 1
        return calls === 1 ? JSON.stringify({ done: ['ok'] }) : 'not json at all'
      }
    }
    const ledger = emptySessionSummaryLedger()
    await expect(
      foldSessionSummaryEvents({
        brain,
        ledger,
        events: events(45),
        signal: new AbortController().signal
      })
    ).rejects.toThrow()
    expect(ledger.foldedThrough).toBe(0)
    expect(ledger.done).toEqual([])
  })

  it('stops when the signal aborts', async () => {
    const controller = new AbortController()
    const brain: SessionFoldBrain = {
      complete: async () => {
        controller.abort()
        return JSON.stringify({ done: ['never applied'] })
      }
    }
    await expect(
      foldSessionSummaryEvents({
        brain,
        ledger: emptySessionSummaryLedger(),
        events: events(5),
        signal: controller.signal
      })
    ).rejects.toThrow()
  })
})

describe('buildSessionSummaryChunkPrompt', () => {
  it('renders indexed events with roles', () => {
    const prompt = buildSessionSummaryChunkPrompt(events(3), { from: 1, to: 3 }, 10)
    expect(prompt).toContain('[#11 assistant] message 1')
    expect(prompt).toContain('[#12 user] message 2')
    expect(prompt).not.toContain('message 0')
  })
})
