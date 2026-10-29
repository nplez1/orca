import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSummarySnapshot } from '../../shared/session-summary-types'
import { SessionSummaryStore } from './session-summary-store'
import { SessionSummaryService, type SessionSummaryStatusEntry } from './session-summary-service'
import type { SessionSummarySourceEvent } from './session-summary-fold'

function events(count: number): SessionSummarySourceEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `message ${index}`,
    timestamp: null
  }))
}

let storeSeq = 0
function testStore(): SessionSummaryStore {
  storeSeq += 1
  return new SessionSummaryStore(
    join(tmpdir(), `session-summary-identity-${storeSeq}-${Date.now()}.json`)
  )
}

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
    const store = testStore()
    const reads: unknown[] = []
    const service = new SessionSummaryService({
      store,
      readEvents: async ({ identity, fromEventIndex }) => {
        reads.push(identity)
        const all = events(2)
        return { events: all.slice(fromEventIndex), totalEvents: all.length }
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
    const store = testStore()
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
    const store = testStore()
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
    const store = testStore()
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
      readEvents: async ({ fromEventIndex }) => {
        const all = events(3)
        return { events: all.slice(fromEventIndex), totalEvents: all.length }
      },
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
    const store = testStore()
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
