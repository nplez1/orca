import { describe, expect, it } from 'vitest'
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
      readEvents: async ({ host }) => {
        hostReads.push({ host })
        return args.events
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
              goal: 'Summmarized on the host',
              plan: [],
              inProgress: null,
              done: [],
              blockers: [],
              decisions: [],
              timeline: [],
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
    await new Promise((resolve) => setTimeout(resolve, 40))
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
    await new Promise((resolve) => setTimeout(resolve, 40))

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

// The viewer holds the pane, so it is the process guaranteed to know which session is on
// screen. A fold that insists on its own status row reported "no readable transcript" for a
// live session whenever that row was absent — on a paired host that only runs the PTY, or on
// a client whose rows were cleared by a reconnect.
describe('SessionSummaryService viewer-supplied identity', () => {
  const piSession = {
    agentType: 'pi' as const,
    providerSession: {
      key: 'session_id' as const,
      id: 'pi-session-1',
      transcriptPath: '/home/user/.pi/agent/sessions/--srv-code--/pi-session-1.jsonl'
    }
  }

  function identityHarness(entry: SessionSummaryStatusEntry | undefined): {
    service: SessionSummaryService
    updates: SessionSummarySnapshot[]
    reads: unknown[]
  } {
    const { store } = testStore()
    const reads: unknown[] = []
    const service = new SessionSummaryService({
      store,
      readEvents: async ({ identity }) => {
        reads.push(identity)
        return events(2)
      },
      getAgentStatusEntry: () => entry,
      createBrain: () => ({
        complete: async () => JSON.stringify({ inProgress: 'folding' })
      }),
      now: () => 1000
    })
    const updates: SessionSummarySnapshot[] = []
    service.onUpdate((snapshot) => updates.push(snapshot))
    return { service, updates, reads }
  }

  it('folds a pane with no row here, from the identity the viewer sent', async () => {
    const { service, updates, reads } = identityHarness(undefined)

    const opened = service.open({ paneKey: 'tab:leaf', session: piSession })
    expect(opened.status).toBe('folding')
    await waitFor(() => updates.some((u) => u.status === 'ready'))

    expect(reads[0]).toEqual(piSession)
    expect(updates.some((u) => u.status === 'unavailable')).toBe(false)
  })

  // Unchanged for a caller that knows nothing: with no row and no identity there is nothing
  // to brief, and the pane still says so instead of folding an empty session.
  it('still reports unavailable when neither a row nor an identity exists', async () => {
    const { service, updates } = identityHarness(undefined)

    expect(service.open({ paneKey: 'tab:leaf' }).status).toBe('unavailable')
    expect(updates).toHaveLength(0)
  })

  // The row names the session; the viewer still holds the path it was relayed without.
  it('fills a row transcript path from the viewer identity', async () => {
    const { service, updates, reads } = identityHarness({
      agentType: 'pi',
      providerSession: { key: 'session_id', id: 'pi-session-1' }
    })

    service.open({ paneKey: 'tab:leaf', session: piSession })
    await waitFor(() => updates.some((u) => u.status === 'ready'))

    expect(reads[0]).toEqual(piSession)
  })

  // Why the row wins here: it is this process's own latest evidence, and folding a lagging
  // viewer's id would brief the previous conversation (#135).
  it('keeps a row that names a different session than the request', async () => {
    const { service, updates, reads } = identityHarness({
      agentType: 'pi',
      providerSession: {
        key: 'session_id',
        id: 'newer-session',
        transcriptPath: '/tmp/newer-session.jsonl'
      }
    })

    service.open({ paneKey: 'tab:leaf', session: piSession })
    await waitFor(() => updates.some((u) => u.status === 'ready'))

    expect(reads[0]).toEqual({
      agentType: 'pi',
      providerSession: {
        key: 'session_id',
        id: 'newer-session',
        transcriptPath: '/tmp/newer-session.jsonl'
      }
    })
  })

  // Why the agent type follows its session: Pi's transcript read with Claude's parser is a
  // conversation neither side has, and it can still produce a wrong brief.
  it('takes the agent type from the side that supplied the session', async () => {
    const { service, updates, reads } = identityHarness({ agentType: 'claude' })

    service.open({ paneKey: 'tab:leaf', session: piSession })
    await waitFor(() => updates.some((u) => u.status === 'ready'))

    expect(reads[0]).toEqual(piSession)
  })

  // Why the failing read is named: one message for "nothing written yet" and "not where its
  // host said it was" left the reader with no way to tell the two apart.
  it('names why a known session produced no transcript', async () => {
    const { service, updates } = identityHarness(undefined)
    const { store } = testStore()
    const unreadable = new SessionSummaryService({
      store,
      readEvents: async () => null,
      getAgentStatusEntry: () => undefined,
      createBrain: () => ({ complete: async () => '{}' }),
      now: () => 1000
    })
    const seen: SessionSummarySnapshot[] = []
    unreadable.onUpdate((snapshot) => seen.push(snapshot))

    unreadable.open({ paneKey: 'tab:leaf', session: piSession })
    await waitFor(() => seen.some((u) => u.status === 'unavailable'))

    expect(seen.find((u) => u.status === 'unavailable')?.error).toContain('pi transcript')
    // And the harness's own fold still reaches ready, so the reason is specific to the read.
    service.open({ paneKey: 'tab:leaf', session: piSession })
    await waitFor(() => updates.some((u) => u.status === 'ready'))
  })
})

// A paired host owns the PTY, but the client owns the pane's layout — so the host's row for
// that pane can be missing or relayed without the agent's transcript path. The identity the
// viewer sends is what lets the host fold a session it cannot identify on its own.
describe('SessionSummaryService host open carries the viewer identity', () => {
  function hostOpenHarness(): { service: SessionSummaryService; opened: unknown[] } {
    const { store } = testStore()
    const opened: unknown[] = []
    const service = new SessionSummaryService({
      store,
      readEvents: async () => null,
      getAgentStatusEntry: () => undefined,
      createBrain: () => ({ complete: async () => '{}' }),
      hostFold: {
        open: async ({ paneKey, session }) => {
          opened.push(session ?? null)
          return hostSnapshotOf(paneKey)
        },
        peek: async ({ paneKey }) => hostSnapshotOf(paneKey),
        close: async () => {}
      },
      // Nothing here waits on a poll: the fold below never settles, which is what the
      // open's own answer is checked against.
      hostPollIntervalMs: 60_000,
      now: () => 1000
    })
    return { service, opened }
  }

  function hostSnapshotOf(paneKey: string): SessionSummarySnapshot {
    return {
      paneKey,
      status: 'folding',
      facts: null,
      ledger: null,
      seenThrough: 0,
      fold: { running: true, completedChunks: 0, totalChunks: 0 }
    }
  }

  it('sends the session the viewer holds with a paired-host open', async () => {
    const { service, opened } = hostOpenHarness()
    const session = {
      agentType: 'pi' as const,
      providerSession: {
        key: 'session_id' as const,
        id: 'pi-1',
        transcriptPath: '/remote/pi-1.jsonl'
      }
    }

    service.open({ paneKey: 'tab:leaf', executionHostId: 'runtime:env-1', session })
    await waitFor(() => opened.length > 0)

    expect(opened[0]).toEqual(session)
    service.close({ paneKey: 'tab:leaf', seenTimelineCount: 0 })
  })

  // An older window sends no identity, and the host then reads its own row: absence is not
  // an error, it is the previous contract.
  it('sends nothing when the request carries no identity and there is no row', async () => {
    const { service, opened } = hostOpenHarness()

    service.open({ paneKey: 'tab:leaf', executionHostId: 'runtime:env-1' })
    await waitFor(() => opened.length > 0)

    expect(opened[0]).toBeNull()
    service.close({ paneKey: 'tab:leaf', seenTimelineCount: 0 })
  })
})

// The stale-ledger guard: a request identity that names the session but not its transcript path
// contradicts nothing, so the ledger and its seen cursor must survive the re-open.
describe('SessionSummaryService stale ledger with a request-only identity', () => {
  it('keeps a ledger the request cannot contradict', async () => {
    const { store } = testStore()
    let currentEntry: SessionSummaryStatusEntry | undefined = {
      agentType: 'pi',
      providerSession: {
        key: 'session_id',
        id: 'pi-1',
        transcriptPath: '/tmp/pi-1.jsonl'
      }
    }
    const service = new SessionSummaryService({
      store,
      readEvents: async () => events(3),
      getAgentStatusEntry: () => currentEntry,
      createBrain: () => ({
        complete: async () =>
          JSON.stringify({
            inProgress: 'folding',
            timeline: [
              { kind: 'milestone', text: 'a', sourceIndex: 0 },
              { kind: 'milestone', text: 'b', sourceIndex: 1 },
              { kind: 'milestone', text: 'c', sourceIndex: 2 }
            ]
          })
      }),
      now: () => 1000
    })
    const updates: SessionSummarySnapshot[] = []
    service.onUpdate((snapshot) => updates.push(snapshot))
    service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => updates.some((u) => u.status === 'ready'))
    service.close({ paneKey: 'tab:leaf', seenTimelineCount: 2 })

    // The row goes away (an idle Pi session parks its identity), so the next open is driven by
    // the request alone — with the same session id and no path.
    currentEntry = undefined
    updates.length = 0
    service.open({
      paneKey: 'tab:leaf',
      session: { agentType: 'pi', providerSession: { key: 'session_id', id: 'pi-1' } }
    })

    expect(store.get('tab:leaf')?.ledger.foldedThrough).toBe(3)
    expect(store.get('tab:leaf')?.seenThrough).toBe(2)
    await waitFor(() => updates.some((u) => u.status === 'ready'))
  })
})

// The reason a known session produced nothing: an agent this build cannot decode must not be
// described as a session whose transcript was not found, which sends the reader looking for a
// file in a format the fold cannot read anyway.
describe('SessionSummaryService unavailable reason', () => {
  function reasonHarness(canReadTranscript: (agentType: string) => boolean) {
    const { store } = testStore()
    const service = new SessionSummaryService({
      store,
      readEvents: async () => null,
      getAgentStatusEntry: () => undefined,
      canReadTranscript: canReadTranscript,
      createBrain: () => ({ complete: async () => '{}' }),
      now: () => 1000
    })
    const updates: SessionSummarySnapshot[] = []
    service.onUpdate((snapshot) => updates.push(snapshot))
    return { service, updates }
  }

  it('names an agent this build cannot decode', async () => {
    const { service, updates } = reasonHarness((agentType) => agentType !== 'amp')

    service.open({
      paneKey: 'tab:leaf',
      session: {
        agentType: 'amp',
        providerSession: { key: 'session_id', id: 'amp-1', transcriptPath: '/tmp/amp-1.jsonl' }
      }
    })
    await waitFor(() => updates.some((u) => u.status === 'unavailable'))

    expect(updates.find((u) => u.status === 'unavailable')?.error).toContain('no transcript reader')
  })

  it('says the reported transcript is unreadable when the agent is supported', async () => {
    const { service, updates } = reasonHarness(() => true)

    service.open({
      paneKey: 'tab:leaf',
      session: {
        agentType: 'pi',
        providerSession: { key: 'session_id', id: 'pi-1', transcriptPath: '/tmp/pi-1.jsonl' }
      }
    })
    await waitFor(() => updates.some((u) => u.status === 'unavailable'))

    expect(updates.find((u) => u.status === 'unavailable')?.error).toContain('not readable here')
  })
})
