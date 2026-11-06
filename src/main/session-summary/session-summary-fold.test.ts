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
import { SESSION_SUMMARY_FOLD_CHUNK_CONCURRENCY } from './session-summary-fold-slots'
import { SESSION_SUMMARY_REPORT_MAX_SECTIONS } from '../../shared/session-summary-types'

const REPORT_PROMPT_PREFIX = 'You write the progress report'

function events(count: number): SessionSummarySourceEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `message ${index}`,
    timestamp: null
  }))
}

function reply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    headline: 'a headline',
    section: { title: 'a phase', text: 'something happened' },
    startNew: false,
    since: 'since text',
    ...overrides
  })
}

/** A brain that answers chunk extracts with JSON and report calls with a report. */
function jsonBrain(handler: (prompt: string, call: number) => unknown): SessionFoldBrain {
  let calls = 0
  return {
    complete: async ({ prompt }) => {
      calls += 1
      // The fold's second phase asks for the prose report; a JSON-only brain would otherwise
      // count as a chunk call and answer with a chunk extract.
      if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
        return reply()
      }
      return JSON.stringify(handler(prompt, calls))
    }
  }
}

describe('buildSessionSummaryChunks', () => {
  it('covers every event exactly once and respects the event cap', () => {
    const ranges = buildSessionSummaryChunks(events(250))
    expect(ranges[0]).toEqual({ from: 0, to: 120 })
    expect(ranges.at(-1)?.to).toBe(250)
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
    const ranges = buildSessionSummaryChunks(long, 3000, 120)
    expect(ranges.length).toBeGreaterThan(1)
    expect(ranges.at(-1)?.to).toBe(4)
  })

  // User and assistant text is no longer cut, so one message can exceed a prompt on its own. It is
  // still one event: the parts are a paging device, not a filter.
  it('splits one oversized event into parts without renumbering it', () => {
    const oversized: SessionSummarySourceEvent[] = [
      { role: 'user', text: 'short', timestamp: null },
      { role: 'assistant', text: 'z'.repeat(7_000), timestamp: null }
    ]
    const ranges = buildSessionSummaryChunks(oversized, 3_000, 120)
    expect(ranges[0]).toEqual({ from: 0, to: 1 })
    const parts = ranges.slice(1)
    expect(parts.length).toBe(3)
    for (const part of parts) {
      expect(part.from).toBe(1)
      expect(part.to).toBe(2)
    }
    expect(parts[0].partFrom).toBe(0)
    expect(parts.at(-1)?.partTo).toBe(7_000)
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

describe('buildSessionSummaryChunkPrompt', () => {
  it('renders indexed events with roles', () => {
    const prompt = buildSessionSummaryChunkPrompt(events(3), { from: 1, to: 3 }, 10)
    expect(prompt).toContain('[#11 assistant] message 1')
    expect(prompt).toContain('[#12 user] message 2')
    expect(prompt).not.toContain('message 0')
  })

  // A record the reader could not decode is a hole in "the entire log" unless the prompt names it.
  it('names a skipped record in the slice that covers it', () => {
    const prompt = buildSessionSummaryChunkPrompt(events(3), { from: 1, to: 3 }, 0, [
      { afterEventIndex: 2, text: 'Skipped 1 oversized transcript record.' }
    ])
    expect(prompt).toContain('[gap after #1] Skipped 1 oversized transcript record.')
  })

  it('renders a part with its own label and no other part of the message', () => {
    const prompt = buildSessionSummaryChunkPrompt(
      [{ role: 'assistant', text: 'aaaaabbbbb', timestamp: null }],
      { from: 0, to: 1, partFrom: 5, partTo: 10, partIndex: 1, partCount: 2 },
      0
    )
    expect(prompt).toContain('[#0 assistant · part 2 of 2] bbbbb')
    expect(prompt).not.toContain('aaaaa')
  })
})

describe('foldSessionSummaryEvents', () => {
  it('folds chunks in order and advances foldedThrough', async () => {
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
      events: events(130),
      signal: new AbortController().signal
    })
    expect(result.totalChunks).toBe(2)
    expect(result.gap).toBeNull()
    expect(result.ledger.foldedThrough).toBe(130)
    // A fact the extract did not index lands at its slice's last message, so it is inside the
    // "since your last message" window rather than on its boundary.
    expect(result.ledger.done).toEqual([
      { text: 'chunk 1', sourceIndex: 119 },
      { text: 'chunk 2', sourceIndex: 129 }
    ])
    expect(result.ledger.timeline.map((entry) => entry.text)).toEqual(['m1', 'm2'])
    expect(result.ledger.reportFull?.headline).toBe('a headline')
    // events(130) alternates user/assistant from a user message: 65 reader messages.
    expect(result.ledger.userMessageCount).toBe(65)
    expect(result.ledger.lastUserMessageIndex).toBe(128)
    expect(seenPrompts[0]).toContain('#0 user')
    expect(seenPrompts[1]).toContain('#120 ')
  })

  it('reuses cached chunk extracts instead of calling the brain again', async () => {
    const cacheStore = new Map<string, SessionSummaryLedgerDelta>()
    cacheStore.set('0-120', { done: [{ text: 'cached', sourceIndex: 0 }], timeline: [] })
    let calls = 0
    const brain = jsonBrain(() => {
      calls += 1
      return { done: ['fresh'] }
    })
    const result = await foldSessionSummaryEvents({
      brain,
      ledger: emptySessionSummaryLedger(),
      events: events(130),
      signal: new AbortController().signal,
      cache: {
        get: (key) => cacheStore.get(key),
        set: (key, delta) => {
          cacheStore.set(key, delta)
        }
      }
    })
    expect(calls).toBe(1)
    expect(result.ledger.done).toEqual([
      { text: 'cached', sourceIndex: 0 },
      { text: 'fresh', sourceIndex: 129 }
    ])
  })

  // Acceptance 5: no positional truncation survives. The old fold cut every event at 1,500
  // characters, so which part of a long message reached the model depended on where it sat.
  it('sends user and assistant text in full', async () => {
    const longUser = `start-${'u'.repeat(4_000)}-end-user`
    const longAssistant = `start-${'a'.repeat(4_000)}-end-assistant`
    const prompts: string[] = []
    const brain: SessionFoldBrain = {
      complete: async ({ prompt }) => {
        if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
          return reply()
        }
        prompts.push(prompt)
        return JSON.stringify({ done: ['ok'] })
      }
    }
    await foldSessionSummaryEvents({
      brain,
      ledger: emptySessionSummaryLedger(),
      events: [
        { role: 'user', text: longUser, timestamp: null },
        { role: 'assistant', text: longAssistant, timestamp: null }
      ],
      signal: new AbortController().signal
    })
    const all = prompts.join('\n')
    expect(all).toContain('-end-user')
    expect(all).toContain('-end-assistant')
    expect(all).not.toContain('…')
  })

  it('stops a fold whose first chunk fails, rather than calling the brain once per chunk', async () => {
    const siblingSignals: AbortSignal[] = []
    let calls = 0
    const brain: SessionFoldBrain = {
      complete: async ({ prompt, signal }) => {
        if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
          return reply()
        }
        calls += 1
        // Why by prompt and not by call count: the retry is the point, so the failure has to be a
        // property of the chunk rather than of the first call the brain happens to see.
        if (prompt.includes('[#0 ')) {
          throw new Error('extract failed')
        }
        if (signal.aborted) {
          throw new Error('aborted')
        }
        siblingSignals.push(signal)
        // Why a zero-delay yield: the sibling only has to still be awaiting something when the
        // first call's failure lands; a real delay adds nothing but wall-clock dependence.
        await new Promise((resolve) => setTimeout(resolve, 0))
        return JSON.stringify({ done: ['late'] })
      }
    }

    await expect(
      foldSessionSummaryEvents({
        brain,
        ledger: emptySessionSummaryLedger(),
        events: events(2_000),
        signal: new AbortController().signal
      })
    ).rejects.toThrow('extract failed')

    expect(siblingSignals.every((signal) => signal.aborted)).toBe(true)
    // The chunks already in flight finish or abort, and nothing new starts: a broken brain must not
    // spawn a call per chunk of a seventeen-chunk session.
    expect(calls).toBeLessThanOrEqual(SESSION_SUMMARY_FOLD_CHUNK_CONCURRENCY + 2)
  })

  // Acceptance 6: one flaky call out of forty must not throw away thirty-nine chunks of work.
  it('applies the chunks before a failure and records the gap', async () => {
    const cacheStore = new Map<string, SessionSummaryLedgerDelta>()
    const prompts: string[] = []
    const brain = jsonBrain((prompt) => {
      prompts.push(prompt)
      // The third chunk's prompt opens at event 240; fail it, and only it, on both attempts.
      if (prompt.includes('[#240 ')) {
        throw new Error('flaky cli')
      }
      return { done: [`chunk at ${prompts.length}`] }
    })
    const result = await foldSessionSummaryEvents({
      brain,
      ledger: emptySessionSummaryLedger(),
      events: events(480),
      signal: new AbortController().signal,
      cache: { get: (key) => cacheStore.get(key), set: (key, delta) => cacheStore.set(key, delta) }
    })

    expect(result.totalChunks).toBe(4)
    expect(result.completedChunks).toBe(2)
    expect(result.gap).toEqual({ completedChunks: 2, totalChunks: 4 })
    // The cursor stops where the failed chunk begins: applying a later chunk would either renumber
    // the events or append its timeline entries twice on the next fold.
    expect(result.ledger.foldedThrough).toBe(240)
    expect(result.ledger.foldGap).toEqual({ completedChunks: 2, totalChunks: 4 })
    expect(result.ledger.done).toHaveLength(2)
    // The chunks after the failure are still cached, so the next fold does not pay for them again.
    expect([...cacheStore.keys()].sort()).toEqual(['0-120', '120-240', '360-480'])
  })

  it('resumes after a failure without re-asking for the chunks already summarized', async () => {
    const cacheStore = new Map<string, SessionSummaryLedgerDelta>()
    let failChunk = true
    let chunkCalls = 0
    const brain: SessionFoldBrain = {
      complete: async ({ prompt }) => {
        if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
          return reply()
        }
        chunkCalls += 1
        if (failChunk && prompt.includes('[#240 ')) {
          throw new Error('flaky cli')
        }
        return JSON.stringify({ done: [`chunk ${chunkCalls}`] })
      }
    }
    const cache = {
      get: (key: string) => cacheStore.get(key),
      set: (key: string, delta: SessionSummaryLedgerDelta) => cacheStore.set(key, delta)
    }
    const first = await foldSessionSummaryEvents({
      brain,
      ledger: emptySessionSummaryLedger(),
      events: events(480),
      signal: new AbortController().signal,
      cache
    })
    failChunk = false
    chunkCalls = 0
    const second = await foldSessionSummaryEvents({
      brain,
      ledger: first.ledger,
      events: events(480).slice(first.ledger.foldedThrough),
      signal: new AbortController().signal,
      cache
    })
    // Only the chunk that failed is asked for again; the two after it came from the cache.
    expect(chunkCalls).toBe(1)
    expect(second.gap).toBeNull()
    expect(second.ledger.foldedThrough).toBe(480)
    // The facts of the chunks after the failure were not applied twice on the resume.
    const texts = second.ledger.done.map((fact) => fact.text)
    expect(new Set(texts).size).toBe(texts.length)
  })

  // Acceptance 7: an interrupted first fold must resume rather than restart at event 0.
  it('keeps completed chunk extracts when the fold is interrupted', async () => {
    const cacheStore = new Map<string, SessionSummaryLedgerDelta>()
    const controller = new AbortController()
    const brain: SessionFoldBrain = {
      complete: async ({ prompt }) => {
        if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
          return reply()
        }
        return JSON.stringify({ done: ['chunk'] })
      }
    }
    const cache = {
      get: (key: string) => cacheStore.get(key),
      set: (key: string, delta: SessionSummaryLedgerDelta) => cacheStore.set(key, delta)
    }
    let settled = 0
    await expect(
      foldSessionSummaryEvents({
        brain,
        ledger: emptySessionSummaryLedger(),
        events: events(480),
        signal: controller.signal,
        cache,
        // The reader closed the pane after the first chunk came back, which is what the runner's
        // per-chunk persist is for: the extract is already on disk when the rest is cancelled.
        onChunkSettled: () => {
          settled += 1
          if (settled === 1) {
            controller.abort()
          }
        }
      })
    ).rejects.toThrow()

    expect(cacheStore.size).toBeGreaterThan(0)
    let secondCalls = 0
    const resumed = await foldSessionSummaryEvents({
      brain: {
        complete: async ({ prompt }) => {
          if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
            return reply()
          }
          secondCalls += 1
          return JSON.stringify({ done: ['resumed'] })
        }
      },
      ledger: emptySessionSummaryLedger(),
      events: events(480),
      signal: new AbortController().signal,
      cache
    })
    // Four chunks, at least one already cached: resuming is strictly cheaper than restarting.
    expect(secondCalls).toBeLessThan(4)
    expect(resumed.ledger.foldedThrough).toBe(480)
  })

  // A degraded fold stops at the first failed chunk, so counting the reader's messages across the
  // whole read would count the ones the next fold is about to count again.
  it('does not count the reader’s messages twice across a degraded fold', async () => {
    const brain: SessionFoldBrain = {
      complete: async ({ prompt }) => {
        if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
          return reply()
        }
        if (prompt.includes('[#240 ')) {
          throw new Error('flaky cli')
        }
        return JSON.stringify({ done: ['ok'], timeline: [] })
      }
    }
    const first = await foldSessionSummaryEvents({
      brain,
      ledger: emptySessionSummaryLedger(),
      events: events(480),
      signal: new AbortController().signal
    })
    expect(first.ledger.foldedThrough).toBe(240)
    // events(480) alternates from a user message: 240 reader messages in total, 120 of them folded.
    expect(first.ledger.userMessageCount).toBe(120)

    const resumed = await foldSessionSummaryEvents({
      brain: {
        complete: async ({ prompt }) =>
          prompt.startsWith(REPORT_PROMPT_PREFIX)
            ? reply()
            : JSON.stringify({ done: ['ok'], timeline: [] })
      },
      ledger: first.ledger,
      events: events(480).slice(first.ledger.foldedThrough),
      signal: new AbortController().signal
    })
    // The same count a clean fold of all 480 events would produce.
    expect(resumed.ledger.userMessageCount).toBe(240)
    expect(resumed.ledger.lastUserMessageIndex).toBe(478)
  })

  // A message larger than a prompt is sent in parts. The cursor can only stop on an event boundary,
  // so a failure part-way through must roll the whole event out of the applied prefix — otherwise
  // its earlier parts land a second time on the resume.
  it('does not apply half of a split message twice', async () => {
    const long = 'z'.repeat(60_000)
    const cacheStore = new Map<string, SessionSummaryLedgerDelta>()
    const cache = {
      get: (key: string) => cacheStore.get(key),
      set: (key: string, delta: SessionSummaryLedgerDelta) => cacheStore.set(key, delta)
    }
    let failSecondPart = true
    const brain: SessionFoldBrain = {
      complete: async ({ prompt }) => {
        if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
          return reply()
        }
        if (failSecondPart && prompt.includes('part 2 of 3')) {
          throw new Error('flaky cli')
        }
        const part = /part (\d) of (\d)/.exec(prompt)?.[1] ?? '1'
        return JSON.stringify({ done: [`part ${part}`], timeline: [] })
      }
    }
    await expect(
      foldSessionSummaryEvents({
        brain,
        ledger: emptySessionSummaryLedger(),
        events: [{ role: 'assistant', text: long, timestamp: null }],
        signal: new AbortController().signal,
        cache
      })
    ).rejects.toThrow()
    // Nothing landed: the parts that did settle were cached, not applied, and the failed one has no
    // entry so the resume retries it.
    expect(cacheStore.has('0-1:0-24000')).toBe(true)
    expect(cacheStore.has('0-1:24000-48000')).toBe(false)

    failSecondPart = false
    const resumed = await foldSessionSummaryEvents({
      brain,
      ledger: emptySessionSummaryLedger(),
      events: [{ role: 'assistant', text: long, timestamp: null }],
      signal: new AbortController().signal,
      cache
    })
    const texts = resumed.ledger.done.map((fact) => fact.text)
    expect(texts).toEqual(['part 1', 'part 2', 'part 3'])
    expect(resumed.ledger.foldedThrough).toBe(1)
  })

  // A chunk that stopped one fold and fails again has to be given up on, or one unsummarizable slice
  // stalls every message after it forever.
  it('gives up on a chunk that has already stopped a fold', async () => {
    const brain: SessionFoldBrain = {
      complete: async ({ prompt }) => {
        if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
          return reply()
        }
        // One slice is unsummarizable, whatever fold asks for it.
        if (prompt.includes('[#240 ')) {
          throw new Error('content filter')
        }
        return JSON.stringify({ done: ['ok'], timeline: [] })
      }
    }
    const first = await foldSessionSummaryEvents({
      brain,
      ledger: emptySessionSummaryLedger(),
      events: events(480),
      signal: new AbortController().signal
    })
    expect(first.gap).toEqual({ completedChunks: 2, totalChunks: 4 })

    const second = await foldSessionSummaryEvents({
      brain,
      ledger: first.ledger,
      events: events(480).slice(first.ledger.foldedThrough),
      signal: new AbortController().signal
    })
    // Given up on rather than stalling: the messages after it are folded and the gap is named.
    expect(second.gap).toBeNull()
    expect(second.ledger.foldedThrough).toBe(480)
    expect(second.ledger.gaps.join(' ')).toContain('Messages #240-#359 could not be summarized')
  })

  it('bounds how many chunk extracts run at once', async () => {
    let inFlight = 0
    let peak = 0
    const brain: SessionFoldBrain = {
      complete: async ({ prompt }) => {
        if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
          return reply()
        }
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 0))
        inFlight -= 1
        return JSON.stringify({ done: ['chunk'] })
      }
    }

    const result = await foldSessionSummaryEvents({
      brain,
      ledger: emptySessionSummaryLedger(),
      events: events(1_200),
      signal: new AbortController().signal
    })

    expect(result.totalChunks).toBeGreaterThan(SESSION_SUMMARY_FOLD_CHUNK_CONCURRENCY)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(SESSION_SUMMARY_FOLD_CHUNK_CONCURRENCY)
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

/** A transcript with a distinctive marker in its first, middle and final third. */
function markedTranscript(count: number): SessionSummarySourceEvent[] {
  const list = events(count)
  for (const [index, marker] of [
    [10, 'MARKER-FIRST'],
    [Math.floor(count / 2), 'MARKER-MIDDLE'],
    [count - 10, 'MARKER-LAST']
  ] as const) {
    list[index] = { role: list[index].role, text: marker, timestamp: null }
  }
  return list
}

describe('a session of any length folds end to end', () => {
  /**
   * A brain that reports the markers it was shown, so the resulting report is evidence of what the
   * fold actually covered rather than of what the fake model was told to say.
   */
  function markerBrain(): { brain: SessionFoldBrain; chunkPrompts: string[] } {
    const chunkPrompts: string[] = []
    const seen = new Set<string>()
    let chunkCalls = 0
    let reportCalls = 0
    return {
      chunkPrompts,
      brain: {
        complete: async ({ prompt }) => {
          for (const marker of ['MARKER-FIRST', 'MARKER-MIDDLE', 'MARKER-LAST']) {
            if (prompt.includes(marker)) {
              seen.add(marker)
            }
          }
          if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
            reportCalls += 1
            const covered = [...seen].join(' ') || `report ${reportCalls}`
            return JSON.stringify({
              headline: covered,
              section: { title: 'phase', text: covered },
              startNew: false,
              since: null
            })
          }
          chunkCalls += 1
          chunkPrompts.push(prompt)
          const markers = ['MARKER-FIRST', 'MARKER-MIDDLE', 'MARKER-LAST'].filter((marker) =>
            prompt.includes(marker)
          )
          return JSON.stringify({
            done: markers.length > 0 ? markers : [`chunk ${chunkCalls}`],
            timeline: []
          })
        }
      }
    }
  }

  // The gate: a summary that mentions only the tail fails, which is the exact failure mode the
  // single-report-call design produced.
  it('covers the first, middle and last third of a 5,000-event session', async () => {
    const { brain, chunkPrompts } = markerBrain()
    const result = await foldSessionSummaryEvents({
      brain,
      ledger: emptySessionSummaryLedger(),
      events: markedTranscript(5_000),
      signal: new AbortController().signal
    })

    const report = result.ledger.reportFull
    const reported = [report?.headline ?? '', ...(report?.sections ?? []).map((s) => s.text)].join(
      ' '
    )
    expect(reported).toContain('MARKER-FIRST')
    expect(reported).toContain('MARKER-MIDDLE')
    expect(reported).toContain('MARKER-LAST')
    expect(result.ledger.foldedThrough).toBe(5_000)
    expect(result.gap).toBeNull()

    // Acceptance 4: every event reached the model exactly once.
    for (const index of [0, 10, 2_500, 4_990, 4_999]) {
      const occurrences = chunkPrompts.reduce(
        (total, prompt) => total + prompt.split(`[#${index} `).length - 1,
        0
      )
      expect(occurrences).toBe(1)
    }
  })

  // Acceptance 2, both ends: a short session is not padded, and a long one is not clamped to a page
  // of tail.
  it('is proportional to the session rather than to a word count', async () => {
    const short = await foldSessionSummaryEvents({
      brain: markerBrain().brain,
      ledger: emptySessionSummaryLedger(),
      events: events(30),
      signal: new AbortController().signal
    })
    expect(short.ledger.reportFull?.sections).toHaveLength(1)

    const long = await foldSessionSummaryEvents({
      brain: markerBrain().brain,
      ledger: emptySessionSummaryLedger(),
      events: markedTranscript(5_000),
      signal: new AbortController().signal
    })
    const sections = long.ledger.reportFull?.sections ?? []
    expect(sections.length).toBeGreaterThan(1)
    expect(sections.length).toBeLessThanOrEqual(SESSION_SUMMARY_REPORT_MAX_SECTIONS)
    // The sections are ordered oldest first and their positions increase across the session.
    for (let index = 1; index < sections.length; index += 1) {
      expect(sections[index].through).toBeGreaterThan(sections[index - 1].through)
    }
  })

  it('records a skipped record as a named gap on the ledger', async () => {
    const result = await foldSessionSummaryEvents({
      brain: jsonBrain(() => ({ done: ['ok'] })),
      ledger: emptySessionSummaryLedger(),
      events: events(30),
      signal: new AbortController().signal,
      gaps: [{ afterEventIndex: 5, text: 'Skipped 1 oversized transcript record.' }]
    })
    expect(result.ledger.gaps).toEqual(['Skipped 1 oversized transcript record.'])
  })
})
