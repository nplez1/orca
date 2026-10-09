import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSummarySnapshot } from '../../shared/session-summary-types'
import { SessionSummaryStore } from './session-summary-store'
import { SessionSummaryService, type SessionSummaryStatusEntry } from './session-summary-service'
import type { SessionFoldBrain, SessionSummarySourceEvent } from './session-summary-fold'

function events(count: number): SessionSummarySourceEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `message ${index}`,
    timestamp: null
  }))
}

let storeSeq = 0
function testStore(): { store: SessionSummaryStore; path: string } {
  storeSeq += 1
  const path = join(tmpdir(), `session-summary-test-${storeSeq}-${Date.now()}.json`)
  return { store: new SessionSummaryStore(path), path }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

type Harness = {
  service: SessionSummaryService
  updates: SessionSummarySnapshot[]
  brainPrompts: string[]
  setEvents: (events: SessionSummarySourceEvent[] | null) => void
  setEntry: (entry: SessionSummaryStatusEntry | undefined) => void
  setBrainReply: (reply: (prompt: string, signal: AbortSignal) => string | Promise<string>) => void
}

function harness(
  store: SessionSummaryStore,
  sourceEvents: SessionSummarySourceEvent[] | null
): Harness {
  let currentEvents = sourceEvents
  let currentEntry: SessionSummaryStatusEntry | undefined = {
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1', transcriptPath: '/tmp/sess-1.jsonl' },
    state: 'working',
    prompt: 'Build the thing',
    updatedAt: 1
  }
  let brainReply: (prompt: string, signal: AbortSignal) => string | Promise<string> = (prompt) =>
    JSON.stringify({
      inProgress: 'folding',
      timeline: [{ kind: 'milestone', text: prompt.slice(0, 10), sourceIndex: 0 }]
    })
  const brainPrompts: string[] = []
  const brain: SessionFoldBrain = {
    complete: async ({ prompt, signal }) => {
      brainPrompts.push(prompt)
      return brainReply(prompt, signal)
    }
  }
  const service = new SessionSummaryService({
    store,
    readEvents: async () => currentEvents,
    getAgentStatusEntry: () => currentEntry,
    createBrain: () => brain,
    now: () => 1000
  })
  const updates: SessionSummarySnapshot[] = []
  service.onUpdate((snapshot) => updates.push(snapshot))
  return {
    service,
    updates,
    brainPrompts,
    setEvents: (next) => {
      currentEvents = next
    },
    setEntry: (next) => {
      currentEntry = next
    },
    setBrainReply: (reply) => {
      brainReply = reply
    }
  }
}

describe('SessionSummaryService', () => {
  it('folds on open, pushes ready, and persists the ledger', async () => {
    const { store, path } = testStore()
    const { service, updates } = harness(store, events(5))
    const opened = service.open({ paneKey: 'tab:leaf' })
    expect(opened.status).toBe('folding')
    await waitFor(() => updates.some((u) => u.status === 'ready'))
    const ready = updates.find((u) => u.status === 'ready')
    expect(ready?.ledger?.foldedThrough).toBe(5)
    expect(ready?.facts?.messageCount).toBe(5)
    // Persisted: a fresh store over the same file resumes at foldedThrough.
    const reloaded = new SessionSummaryStore(path)
    expect(reloaded.get('tab:leaf')?.ledger.foldedThrough).toBe(5)
  })

  it('reports unavailable when the session has no readable transcript', async () => {
    const { store } = testStore()
    const { service, updates } = harness(store, null)
    service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => updates.some((u) => u.status === 'unavailable'))
    expect(updates.some((u) => u.status === 'ready')).toBe(false)
  })

  // The renderer's header reads `fold.running`, and open()'s return value is the
  // first snapshot it sees. A fold that only reported progress after its first
  // chunk read as "Up to date" for the whole first fold.
  it('reports the fold as in flight before the first chunk comes back', async () => {
    const { store } = testStore()
    const { service, setBrainReply } = harness(store, events(5))
    setBrainReply(() => new Promise<string>(() => {}))

    const opened = service.open({ paneKey: 'tab:leaf' })

    expect(opened.fold.running).toBe(true)
  })

  // A pane whose status row was dropped keeps a provider-session remnant
  // (`server-cleanup.ts`): no state, prompt, or timestamps, but a resumable
  // session — which is all the fold needs to summarize a finished agent.
  it('summarizes a finished session from a provider-session remnant row', async () => {
    const { store } = testStore()
    const { service, updates, setEntry } = harness(store, events(4))
    setEntry({
      agentType: 'claude',
      providerSession: {
        key: 'session_id',
        id: 'sess-done',
        transcriptPath: '/tmp/sess-done.jsonl'
      }
    })

    service.open({ paneKey: 'tab:leaf' })

    await waitFor(() => updates.some((u) => u.status === 'ready'))
    const ready = updates.find((u) => u.status === 'ready')
    expect(ready?.ledger?.foldedThrough).toBe(4)
    expect(updates.some((u) => u.status === 'unavailable')).toBe(false)
  })

  it('cancels the fold on close without reporting failure', async () => {
    const { store } = testStore()
    const { service, updates, setBrainReply } = harness(store, events(5))
    setBrainReply(
      (_prompt, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
    )
    service.open({ paneKey: 'tab:leaf' })
    service.close({ paneKey: 'tab:leaf', seenTimelineCount: 0 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(updates.some((u) => u.status === 'failed')).toBe(false)
    expect(store.get('tab:leaf')?.seenThrough).toBe(0)
  })

  it('resumes from foldedThrough on reopen and keeps the seen cursor', async () => {
    const { store } = testStore()
    const { service, updates, brainPrompts, setEvents, setBrainReply } = harness(store, events(5))
    service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => updates.some((u) => u.status === 'ready'))
    service.close({ paneKey: 'tab:leaf', seenTimelineCount: 1 })
    expect(store.get('tab:leaf')?.seenThrough).toBe(1)

    setEvents(events(9))
    setBrainReply(() =>
      JSON.stringify({
        done: ['more'],
        timeline: [{ kind: 'milestone', text: 'next', sourceIndex: 8 }]
      })
    )
    updates.length = 0
    const reopened = service.open({ paneKey: 'tab:leaf' })
    expect(reopened.seenThrough).toBe(1)
    await waitFor(() => updates.some((u) => u.status === 'ready'))
    // Only the four unseen messages were folded.
    expect(brainPrompts.at(-1)).toContain('[#5 assistant] message 5')
    expect(brainPrompts.at(-1)).not.toContain('[#4 user]')
    const ready = updates.find((u) => u.status === 'ready')
    expect(ready?.ledger?.foldedThrough).toBe(9)
    expect(ready?.ledger?.timeline.map((entry) => entry.text)).toContain('next')
  })

  it('resets the ledger when the pane hosts a different session', async () => {
    const { store } = testStore()
    const { service, updates, setEntry, setEvents } = harness(store, events(5))
    service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => updates.some((u) => u.status === 'ready'))

    setEntry({
      agentType: 'claude',
      providerSession: { key: 'session_id', id: 'sess-2', transcriptPath: '/tmp/sess-2.jsonl' }
    })
    setEvents(events(3))
    updates.length = 0
    const reopened = service.open({ paneKey: 'tab:leaf' })
    expect(reopened.ledger?.foldedThrough ?? 0).toBe(0)
    await waitFor(() => updates.some((u) => u.status === 'ready'))
    expect(updates.find((u) => u.status === 'ready')?.ledger?.foldedThrough).toBe(3)
  })

  it('keeps the last good ledger when a fold fails', async () => {
    const { store } = testStore()
    const { service, updates, setEvents, setBrainReply } = harness(store, events(5))
    service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => updates.some((u) => u.status === 'ready'))

    setEvents(events(9))
    setBrainReply(() => 'garbage, not JSON')
    updates.length = 0
    service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => updates.some((u) => u.status === 'failed'))
    const failed = updates.find((u) => u.status === 'failed')
    expect(failed?.ledger?.foldedThrough).toBe(5)
    expect(failed?.error).toContain('JSON')
  })
})
