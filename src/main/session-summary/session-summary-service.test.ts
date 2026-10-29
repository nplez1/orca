import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSummarySnapshot } from '../../shared/session-summary-types'
import { SessionSummaryStore } from './session-summary-store'
import { SessionSummaryService, type SessionSummaryStatusEntry } from './session-summary-service'
import type { SessionFoldBrain, SessionSummarySourceEvent } from './session-summary-fold'
import type { SessionSummaryTranscriptHost } from './session-summary-transcript-host'

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

// Under fake timers vi.waitFor advances the clock by `interval` on every check, which is what
// steps the host subscription's polling.
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) {
        throw new Error('timed out waiting for condition')
      }
    },
    { timeout: timeoutMs, interval: 5 }
  )
}

// The service's only async work is mocked promises, synchronous store writes and the host
// subscription's poll timers, so fake time drives all of it.
beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

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
      // The fold's report phase is a second prompt; answering it here keeps the two phases
      // separate so a test can assert on either.
      if (prompt.startsWith('You write short progress reports')) {
        return JSON.stringify({ since: 'since-report', full: 'full-report' })
      }
      return brainReply(prompt, signal)
    }
  }
  const service = new SessionSummaryService({
    store,
    readEvents: async ({ fromEventIndex }) =>
      currentEvents
        ? { events: currentEvents.slice(fromEventIndex), totalEvents: currentEvents.length }
        : null,
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
    // Persisted: a fresh store over the same file resumes at foldedThrough. `set` is debounced, so a
    // reopen inside the window sees it only after the queued write is flushed.
    store.flush()
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
    await vi.advanceTimersByTimeAsync(50)
    expect(updates.some((u) => u.status === 'failed')).toBe(false)
    // Nothing folded, so there is nothing to remember — see the next test.
    expect(store.get('tab:leaf')).toBeNull()
  })

  // #135: close() used to write an entry around an empty ledger, so the next visit
  // read a non-null ledger as "Up to date" and rendered a blank body.
  it('does not turn a session that never folded into an up-to-date summary', async () => {
    const { store } = testStore()
    const { service, updates } = harness(store, null)
    service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => updates.some((u) => u.status === 'unavailable'))
    service.close({ paneKey: 'tab:leaf', seenTimelineCount: 0 })

    updates.length = 0
    const reopened = service.open({ paneKey: 'tab:leaf' })

    // The decisive part: no ledger to show, so the header cannot claim "Up to date".
    expect(reopened.ledger).toBeNull()
    await waitFor(() => updates.some((u) => u.status === 'unavailable' && !u.ledger))
    expect(reopened.seenThrough).toBe(0)
  })

  it('does not record a failed first fold as a summary', async () => {
    const { store } = testStore()
    const { service, updates, setBrainReply } = harness(store, events(5))
    setBrainReply(() => 'not json at all')
    service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => updates.some((u) => u.status === 'failed'))
    service.close({ paneKey: 'tab:leaf', seenTimelineCount: 0 })

    expect(store.get('tab:leaf')).toBeNull()
    updates.length = 0
    // Reopening retries instead of claiming a summary of nothing.
    expect(service.open({ paneKey: 'tab:leaf' }).status).toBe('folding')
  })

  it('clears the previous ledger when a new session takes the pane', async () => {
    const { store } = testStore()
    const { service, updates, setEntry, setEvents } = harness(store, events(5))
    service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => updates.some((u) => u.status === 'ready'))

    setEntry({
      agentType: 'claude',
      providerSession: { key: 'session_id', id: 'sess-2', transcriptPath: '/tmp/sess-2.jsonl' }
    })
    setEvents(null)
    updates.length = 0
    const reopened = service.open({ paneKey: 'tab:leaf' })

    // The previous conversation's brief must not stand in for the new one.
    expect(reopened.ledger).toBeNull()
    await waitFor(() => updates.some((u) => u.status === 'unavailable'))
    expect(store.get('tab:leaf')).toBeNull()
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
    const chunkPrompt = brainPrompts.findLast((prompt) => prompt.includes('Transcript slice:'))
    expect(chunkPrompt).toContain('[#5 assistant] message 5')
    expect(chunkPrompt).not.toContain('[#4 user]')
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

  // Both reports are written during the fold, so the pane's window/full switch is a
  // re-render: one report answers "since my last message", the other the whole session.
  it('stores both reports a fold wrote', async () => {
    const { store } = testStore()
    const { service, updates } = harness(store, events(5))
    service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => updates.some((u) => u.status === 'ready'))

    const ready = updates.find((u) => u.status === 'ready')
    expect(ready?.ledger?.reportFull?.text).toBe('full-report')
    // events(5) starts with a user message and alternates: three reader messages in total.
    expect(ready?.ledger?.reportSince?.text).toBe('since-report')
    expect(ready?.ledger?.userMessageCount).toBe(3)
    expect(store.get('tab:leaf')?.ledger.reportFull?.text).toBe('full-report')
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

describe('SessionSummaryService host routing', () => {
  type HostHarness = Harness & {
    hostReads: { host: SessionSummaryTranscriptHost }[]
    hostFoldCalls: string[]
    receivedFoldParams: unknown[]
    receivedSessions: unknown[]
    setHostSnapshot: (snapshot: SessionSummarySnapshot | null) => void
  }

  function hostHarness(args: {
    store: SessionSummaryStore
    events: SessionSummarySourceEvent[] | null
    hostSnapshot?: SessionSummarySnapshot
    foldFails?: Error
    entry?: SessionSummaryStatusEntry | undefined
    resolveFoldParams?: () => { agentId: 'claude'; model: string } | null
  }): HostHarness {
    const currentEntry: SessionSummaryStatusEntry | undefined =
      'entry' in args
        ? args.entry
        : {
            agentType: 'pi',
            providerSession: {
              key: 'session_id',
              id: 'sess-1',
              transcriptPath: '/remote/sess-1.jsonl'
            }
          }
    let hostSnapshot = args.hostSnapshot ?? null
    const hostReads: { host: SessionSummaryTranscriptHost }[] = []
    const hostFoldCalls: string[] = []
    const receivedFoldParams: unknown[] = []
    const receivedSessions: unknown[] = []
    const updates: SessionSummarySnapshot[] = []
    const service = new SessionSummaryService({
      store: args.store,
      readEvents: async ({ host, fromEventIndex }) => {
        hostReads.push({ host })
        return args.events
          ? { events: args.events.slice(fromEventIndex), totalEvents: args.events.length }
          : null
      },
      getAgentStatusEntry: () => currentEntry,
      createBrain: () => ({
        complete: async () => JSON.stringify({ inProgress: 'folding' })
      }),
      hostFold: {
        open: async ({ environmentId, paneKey, foldParams, session }) => {
          hostFoldCalls.push(`open:${environmentId}:${paneKey}`)
          receivedFoldParams.push(foldParams)
          receivedSessions.push(session ?? null)
          if (args.foldFails) {
            throw args.foldFails
          }
          return hostSnapshot ?? hostSnapshotFor(paneKey, 'folding')
        },
        peek: async ({ environmentId, paneKey }) => {
          hostFoldCalls.push(`peek:${environmentId}:${paneKey}`)
          return hostSnapshot ?? hostSnapshotFor(paneKey, 'folding')
        },
        close: async ({ environmentId, paneKey, seenTimelineCount }) => {
          hostFoldCalls.push(`close:${environmentId}:${paneKey}:${seenTimelineCount}`)
        }
      },
      hostPollIntervalMs: 5,
      ...(args.resolveFoldParams ? { resolveFoldParams: args.resolveFoldParams } : {}),
      now: () => 1000
    })
    service.onUpdate((snapshot) => updates.push(snapshot))
    return {
      service,
      updates,
      hostReads,
      hostFoldCalls,
      receivedFoldParams,
      receivedSessions,
      brainPrompts: [],
      setEvents: () => {},
      setEntry: () => {},
      setBrainReply: () => {},
      setHostSnapshot: (next) => {
        hostSnapshot = next
      }
    }
  }

  function hostSnapshotFor(paneKey: string, status: 'folding' | 'ready'): SessionSummarySnapshot {
    return {
      paneKey,
      status,
      facts: null,
      ledger:
        status === 'ready'
          ? {
              goal: { text: 'Summmarized on the host', sourceIndex: 1 },
              plan: [],
              inProgress: null,
              done: [],
              blockers: [],
              decisions: [],
              timeline: [],
              reportSince: null,
              reportFull: { text: 'Summarized on the host.', through: 3 },
              lastUserMessageIndex: 0,
              userMessageCount: 1,
              foldedThrough: 3,
              foldedAt: 1
            }
          : null,
      seenThrough: 0,
      fold: { running: status === 'folding', completedChunks: 0, totalChunks: 0 }
    }
  }

  it('reads a local session on this machine', async () => {
    const { store } = testStore()
    const h = hostHarness({ store, events: events(2) })
    h.service.open({ paneKey: 'tab:leaf', executionHostId: 'local' })

    expect(h.hostReads[0]?.host).toEqual({ kind: 'local' })
  })

  // The row's connection is the host that wrote the transcript, whatever the client's
  // workspace says: a path only reads on the machine that produced it.
  it('reads an SSH session from the connection its status row names', async () => {
    const { store } = testStore()
    const h = hostHarness({ store, events: events(2) })
    h.service.open({ paneKey: 'tab:leaf', executionHostId: 'ssh:other-target' })

    expect(h.hostReads[0]?.host.kind).toBe('ssh')
  })

  // #135: a paired host folds its own sessions — the same code that would run if the
  // user were working on that machine — and the desktop only relays its snapshots.
  it('folds a paired host session on that host and relays its snapshots', async () => {
    const { store } = testStore()
    const h = hostHarness({ store, events: events(2) })
    h.service.open({ paneKey: 'tab:leaf', executionHostId: 'runtime:env-1' })
    await waitFor(() => h.hostFoldCalls.some((c) => c.startsWith('peek:')))
    h.setHostSnapshot(hostSnapshotFor('tab:leaf', 'ready'))
    await waitFor(() => h.updates.some((u) => u.status === 'ready'))

    expect(h.hostFoldCalls[0]).toBe('open:env-1:tab:leaf')
    expect(h.updates.find((u) => u.status === 'ready')?.ledger?.foldedThrough).toBe(3)
    // The transcript is read on the host, never here.
    expect(h.hostReads).toHaveLength(0)
    expect(store.get('tab:leaf')).toBeNull()
    h.service.close({ paneKey: 'tab:leaf', seenTimelineCount: 4 })
    expect(h.hostFoldCalls.at(-1)).toBe('close:env-1:tab:leaf:4')
  })

  // The remote half of #135: this client clears connection rows on reconnect, so a pane
  // with no local row must still be summarized — the host keeps the rows for its own
  // sessions, and asking it is what makes the tab work on a paired host at all.
  it('summarizes a paired host pane even when this client has no status row for it', async () => {
    const { store } = testStore()
    const h = hostHarness({
      store,
      events: null,
      entry: undefined,
      hostSnapshot: hostSnapshotFor('tab:leaf', 'ready')
    })

    const opened = h.service.open({ paneKey: 'tab:leaf', executionHostId: 'runtime:env-1' })
    await waitFor(() => h.updates.some((u) => u.status === 'ready'))

    expect(opened.status).toBe('folding')
    expect(h.hostFoldCalls[0]).toBe('open:env-1:tab:leaf')
    expect(h.updates.find((u) => u.status === 'ready')?.ledger?.foldedThrough).toBe(3)
    expect(h.updates.some((u) => u.status === 'unavailable')).toBe(false)
  })

  // The host spawns the agent, so it cannot know this window's Settings → Agents choice:
  // the request has to carry it, or every paired-host fold fails on a null config.
  it('sends the resolved fold params with a host open when the request has none', async () => {
    const { store } = testStore()
    const h = hostHarness({
      store,
      events: null,
      hostSnapshot: hostSnapshotFor('tab:leaf', 'folding'),
      resolveFoldParams: () => ({ agentId: 'claude', model: 'sonnet' })
    })
    h.service.open({ paneKey: 'tab:leaf', executionHostId: 'runtime:env-1' })
    await waitFor(() => h.hostFoldCalls.some((c) => c.startsWith('open:')))

    expect(h.receivedFoldParams[0]).toEqual({ agentId: 'claude', model: 'sonnet' })
  })

  it('keeps polling a paired host fold until it settles', async () => {
    const { store } = testStore()
    const h = hostHarness({
      store,
      events: null,
      hostSnapshot: hostSnapshotFor('tab:leaf', 'folding')
    })
    h.service.open({ paneKey: 'tab:leaf', executionHostId: 'runtime:env-1' })
    await waitFor(() => h.hostFoldCalls.filter((c) => c.startsWith('peek:')).length >= 2)
    h.setHostSnapshot(hostSnapshotFor('tab:leaf', 'ready'))
    await waitFor(() => h.updates.some((u) => u.status === 'ready'))

    // Settled: polling stops instead of running for the life of the pane.
    const seen = h.hostFoldCalls.length
    await vi.advanceTimersByTimeAsync(40)
    expect(h.hostFoldCalls.length).toBe(seen)
  })

  it('stops polling when the pane closes', async () => {
    const { store } = testStore()
    const h = hostHarness({
      store,
      events: null,
      hostSnapshot: hostSnapshotFor('tab:leaf', 'folding')
    })
    h.service.open({ paneKey: 'tab:leaf', executionHostId: 'runtime:env-1' })
    await waitFor(() => h.hostFoldCalls.some((c) => c.startsWith('peek:')))
    h.service.close({ paneKey: 'tab:leaf', seenTimelineCount: 0 })
    const seen = h.hostFoldCalls.length
    await vi.advanceTimersByTimeAsync(40)

    expect(h.hostFoldCalls.length).toBe(seen)
  })

  // A cleared status row is normal after a reconnect. It yields a null identity, which
  // differs from every stored one — deleting a perfectly good ledger on reopen.
  it('keeps a good ledger when the status row is missing on reopen', async () => {
    const { store } = testStore()
    const h = hostHarness({ store, events: events(3) })
    h.service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => h.updates.some((u) => u.status === 'ready'))
    h.service.close({ paneKey: 'tab:leaf', seenTimelineCount: 1 })

    // Entry `undefined` models the cleared row; the stored ledger must survive.
    const reopened = hostHarness({ store, events: events(3), entry: undefined })

    const snapshot = reopened.service.open({ paneKey: 'tab:leaf' })
    expect(snapshot.ledger?.foldedThrough).toBe(3)
    expect(store.get('tab:leaf')?.ledger.foldedThrough).toBe(3)
  })

  // Every open this desktop sends is matched by one close: the host counts viewers itself,
  // so suppressing a close here would strand its count and its fold.
  it('forwards one close per open to a paired host', async () => {
    const { store } = testStore()
    const h = hostHarness({
      store,
      events: null,
      hostSnapshot: hostSnapshotFor('tab:leaf', 'folding')
    })
    h.service.open({ paneKey: 'tab:leaf', executionHostId: 'runtime:env-1' })
    await waitFor(() => h.hostFoldCalls.some((c) => c.startsWith('open:')))
    await waitFor(() => h.updates.length > 0)
    h.service.open({ paneKey: 'tab:leaf', executionHostId: 'runtime:env-1' })
    await waitFor(() => h.updates.length > 1)
    h.service.close({ paneKey: 'tab:leaf', seenTimelineCount: 2 })
    // The first viewer is gone but the second is still reading: the host keeps being polled.
    await waitFor(() => h.hostFoldCalls.filter((c) => c.startsWith('peek:')).length > 0)
    h.service.close({ paneKey: 'tab:leaf', seenTimelineCount: 3 })

    expect(h.hostFoldCalls.filter((c) => c.startsWith('open:'))).toHaveLength(2)
    expect(h.hostFoldCalls.filter((c) => c.startsWith('close:'))).toEqual([
      'close:env-1:tab:leaf:2',
      'close:env-1:tab:leaf:3'
    ])
  })

  // Two viewers of one pane on the host itself: the first to close must not end the other's
  // fold, and the cursor must keep the furthest either of them reached.
  it('does not cancel a fold another viewer still holds', () => {
    const { store } = testStore()
    const h = hostHarness({ store, events: null })
    h.service.open({ paneKey: 'tab:leaf' })
    h.service.open({ paneKey: 'tab:leaf' })
    const folding = h.service.peek('tab:leaf')

    h.service.close({ paneKey: 'tab:leaf', seenTimelineCount: 2 })

    // Still one viewer: the fold is untouched.
    expect(h.service.peek('tab:leaf').fold.running).toBe(folding.fold.running)
    h.service.close({ paneKey: 'tab:leaf', seenTimelineCount: 2 })
    expect(store.get('tab:leaf')).toBeNull()
  })

  it('reports a paired host that cannot answer instead of failing silently', async () => {
    const { store } = testStore()
    const h = hostHarness({
      store,
      events: null,
      foldFails: new Error('host-outdated')
    })
    const opened = h.service.open({ paneKey: 'tab:leaf', executionHostId: 'runtime:env-1' })

    expect(opened.status).toBe('folding')
    await waitFor(() => h.updates.some((u) => u.status === 'failed'))
    expect(h.updates.find((u) => u.status === 'failed')?.error).toBe('host-outdated')
  })

  it('names a host it cannot place rather than reading a path here', async () => {
    const { store } = testStore()
    const h = hostHarness({ store, events: events(2) })
    const opened = h.service.open({ paneKey: 'tab:leaf', executionHostId: 'future-host:abc' })

    expect(opened.status).toBe('unsupported-host')
    expect(h.hostReads).toHaveLength(0)
  })
})
