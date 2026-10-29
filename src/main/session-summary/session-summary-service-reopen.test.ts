import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSummarySnapshot } from '../../shared/session-summary-types'
import { SessionSummaryStore } from './session-summary-store'
import { SessionSummaryService } from './session-summary-service'
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
    join(tmpdir(), `session-summary-reopen-${storeSeq}-${Date.now()}.json`)
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

// A fixed clock: the freshness rule compares the fold's `now` with the row's and the brief's
// stamps, so pinning it keeps every comparison exact.
const NOW = 1_700_000_000_000

// Re-entering the pane is a weak signal: it usually means "show me the brief I left", and a
// fold costs a model call. Only a stale brief over a session that has moved on is re-folded.
describe('SessionSummaryService re-opening the pane', () => {
  function reopenHarness() {
    const store = testStore()
    let reads = 0
    let currentEvents = events(4)
    let entryUpdatedAt = 0
    const service = new SessionSummaryService({
      store,
      readEvents: async ({ fromEventIndex }) => {
        reads += 1
        return {
          events: currentEvents.slice(fromEventIndex),
          totalEvents: currentEvents.length
        }
      },
      getAgentStatusEntry: () => ({
        agentType: 'pi',
        providerSession: { key: 'session_id', id: 'pi-1', transcriptPath: '/tmp/pi-1.jsonl' },
        updatedAt: entryUpdatedAt
      }),
      canReadTranscript: () => true,
      createBrain: () => ({
        complete: async ({ prompt }) =>
          prompt.startsWith('You write short progress reports')
            ? JSON.stringify({ since: 's', full: 'f' })
            : JSON.stringify({ inProgress: 'folding' })
      }),
      now: () => NOW
    })
    const updates: SessionSummarySnapshot[] = []
    service.onUpdate((snapshot) => updates.push(snapshot))
    return {
      service,
      updates,
      store,
      reads: () => reads,
      /** Moves the row's own clock, which is what "the agent did something" means here. */
      setAgentUpdatedAt: (at: number) => {
        entryUpdatedAt = at
      },
      /** Ages the stored brief, so the freshness window can be exercised without waiting. */
      ageBrief: (byMs: number) => {
        const stored = store.get('tab:leaf')
        if (stored?.ledger) {
          store.set('tab:leaf', {
            ...stored,
            ledger: { ...stored.ledger, foldedAt: (stored.ledger.foldedAt ?? 0) - byMs }
          })
        }
      }
    }
  }

  async function foldOnce(h: ReturnType<typeof reopenHarness>): Promise<number> {
    h.service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => h.updates.some((u) => u.status === 'ready'))
    return h.reads()
  }

  it('answers a re-open with the stored brief while it is fresh', async () => {
    const h = reopenHarness()
    const afterFirstFold = await foldOnce(h)
    h.setAgentUpdatedAt(NOW + 1_000)

    const reopened = h.service.open({ paneKey: 'tab:leaf', revalidateWithinMs: 5 * 60_000 })

    expect(reopened.status).toBe('ready')
    expect(reopened.ledger?.foldedThrough).toBe(4)
    expect(h.reads()).toBe(afterFirstFold)
  })

  // "The agent produced nothing since the last fold" is the stronger signal: the brief is
  // current however old it is, so no time window should force a fold.
  it('does not re-fold a session the agent has not touched since the fold', async () => {
    const h = reopenHarness()
    const afterFirstFold = await foldOnce(h)
    h.ageBrief(10 * 60_000)
    h.setAgentUpdatedAt(NOW - 60_000)

    h.service.open({ paneKey: 'tab:leaf', revalidateWithinMs: 60 * 60_000 })

    expect(h.reads()).toBe(afterFirstFold)
  })

  it('folds again when the brief is stale and the agent has worked since', async () => {
    const h = reopenHarness()
    const afterFirstFold = await foldOnce(h)
    h.ageBrief(10 * 60_000)
    h.setAgentUpdatedAt(NOW + 1_000)

    h.service.open({ paneKey: 'tab:leaf', revalidateWithinMs: 5 * 60_000 })

    await waitFor(() => h.reads() > afterFirstFold)
    expect(h.reads()).toBe(afterFirstFold + 1)
  })

  // The refresh button passes no window: it always folds — and stays cheap when nothing is new,
  // because a fold with no new events never reaches the model.
  it('always folds when the caller asks for no freshness window', async () => {
    const h = reopenHarness()
    const afterFirstFold = await foldOnce(h)
    h.setAgentUpdatedAt(NOW - 60_000)

    h.service.open({ paneKey: 'tab:leaf' })

    await waitFor(() => h.reads() > afterFirstFold)
  })
})
