import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control/ai/source-control-ai-operation-resolution'
import type {
  SessionSummarySnapshot,
  SessionSummaryStatus
} from '../../shared/session-summary-types'
import { runSessionSummaryFold } from './session-summary-fold-runner'
import { SessionSummaryStore } from './session-summary-store'
import type { SessionFoldBrain, SessionSummarySourceEvent } from './session-summary-fold'
import type { SessionSummaryEventRead } from './session-summary-transcript-source'
import type { SessionSummaryTranscriptHost } from './session-summary-transcript-host'

const REPORT_PROMPT_PREFIX = 'You write the progress report'

function events(count: number): SessionSummarySourceEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `message ${index}`,
    timestamp: null
  }))
}

type Update = {
  status: SessionSummaryStatus
  fold: SessionSummarySnapshot['fold']
  messageCount?: number
  error?: string
  progressOnly?: boolean
}

function harness(options: { count: number; brain?: SessionFoldBrain }) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-summary-runner-'))
  const store = new SessionSummaryStore(join(directory, 'session-summaries.json'))
  const all = events(options.count)
  const updates: Update[] = []
  const chunkPrompts: string[] = []
  const brain: SessionFoldBrain = options.brain ?? {
    complete: async ({ prompt }) => {
      if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
        return JSON.stringify({
          headline: 'a headline',
          section: { title: 'a phase', text: 'something happened' },
          startNew: false,
          since: null
        })
      }
      chunkPrompts.push(prompt)
      return JSON.stringify({ done: [`chunk ${chunkPrompts.length}`], timeline: [] })
    }
  }
  const run = (
    signal: AbortSignal,
    read?: (fromEventIndex: number) => Promise<SessionSummaryEventRead | null>
  ): Promise<void> =>
    runSessionSummaryFold({
      deps: {
        store,
        readEvents: async ({ fromEventIndex }) =>
          read
            ? read(fromEventIndex)
            : {
                events: all.slice(fromEventIndex),
                totalEvents: all.length,
                retainedBytes: 0,
                overRetainedBudget: false,
                gaps: []
              },
        getAgentStatusEntry: () => ({
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'sess-1', transcriptPath: '/tmp/s.jsonl' },
          updatedAt: 1
        }),
        canReadTranscript: () => true,
        createBrain: (_params: ResolvedSourceControlAiGenerationParams | null) => brain,
        now: () => 1_000
      },
      callbacks: {
        onStatus: (update) => updates.push(update)
      },
      paneKey: 'tab:leaf',
      host: { kind: 'local' } satisfies SessionSummaryTranscriptHost,
      foldParams: null,
      signal
    })
  return {
    store,
    updates,
    chunkPrompts,
    run,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  }
}

describe('runSessionSummaryFold', () => {
  it('persists each completed chunk, so an interrupted first fold resumes', async () => {
    const test = harness({ count: 480 })
    const controller = new AbortController()
    // The reader closed the pane after the first chunk came back.
    const originalPush = test.updates.push.bind(test.updates)
    test.updates.push = (update: Update): number => {
      const length = originalPush(update)
      if (update.progressOnly) {
        controller.abort()
      }
      return length
    }
    await test.run(controller.signal)

    // The chunk cache is on disk even though the ledger was never produced — the case that used to
    // make an interrupted first fold restart at event 0.
    const cached = Object.keys(test.store.get('tab:leaf')?.chunkCache ?? {})
    expect(cached.length).toBeGreaterThan(0)

    const resumed = harness({ count: 480 })
    resumed.store.set('tab:leaf', test.store.get('tab:leaf')!)
    await resumed.run(new AbortController().signal)
    expect(resumed.chunkPrompts.length).toBeLessThan(4)
    resumed.cleanup()
    test.cleanup()
  })

  it('reports a partial fold as ready with the gap named, not as a failure', async () => {
    const test = harness({
      count: 480,
      brain: {
        complete: async ({ prompt }) => {
          if (prompt.startsWith(REPORT_PROMPT_PREFIX)) {
            return JSON.stringify({
              headline: 'h',
              section: { title: 't', text: 'x' },
              startNew: false,
              since: null
            })
          }
          // The third chunk never works; the first two do.
          if (prompt.includes('[#240 ')) {
            throw new Error('flaky cli')
          }
          return JSON.stringify({ done: ['ok'], timeline: [] })
        }
      }
    })
    await test.run(new AbortController().signal)

    const settled = test.updates.at(-1)
    expect(settled?.status).toBe('ready')
    expect(settled?.fold).toEqual({ running: false, completedChunks: 2, totalChunks: 4 })
    expect(settled?.error).toContain('2 of 4 sections summarized')
    const stored = test.store.get('tab:leaf')
    expect(stored?.ledger.foldGap).toEqual({ completedChunks: 2, totalChunks: 4 })
    expect(stored?.ledger.foldedThrough).toBe(240)
    test.cleanup()
  })

  // A progress tick ships counts, not the ledger: a structured clone of a thousand-entry ledger per
  // completed chunk to every window is what made a long fold stall the pane.
  it('sends progress ticks without the ledger', async () => {
    const test = harness({ count: 240 })
    await test.run(new AbortController().signal)

    const ticks = test.updates.filter((update) => update.progressOnly)
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks[0].fold.running).toBe(true)
    // The settled status still carries the ledger; only the ticks are counts-only.
    expect(test.updates.findLast((update) => !update.progressOnly)?.status).toBe('ready')
    test.cleanup()
  })

  // A report that failed leaves `reportFull.through` behind `foldedThrough`; a session with nothing
  // new must still catch it up, or the hole is permanent.
  it('catches up a report the previous fold could not finish', async () => {
    const test = harness({ count: 120 })
    await test.run(new AbortController().signal)
    const stored = test.store.get('tab:leaf')!
    // Simulate a fold whose report phase failed: facts folded, prose behind.
    test.store.set('tab:leaf', {
      ...stored,
      ledger: {
        ...stored.ledger,
        reportFull: stored.ledger.reportFull ? { ...stored.ledger.reportFull, through: 0 } : null
      }
    })

    const reopened = harness({ count: 120 })
    reopened.store.set('tab:leaf', test.store.get('tab:leaf')!)
    await reopened.run(new AbortController().signal)

    // No new events, so no chunk extract; the report phase still ran.
    expect(reopened.chunkPrompts).toHaveLength(0)
    expect(reopened.store.get('tab:leaf')?.ledger.reportFull?.through).toBe(120)
    reopened.cleanup()
    test.cleanup()
  })
})
